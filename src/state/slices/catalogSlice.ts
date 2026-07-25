import type { StateCreator } from "zustand";
import {
  api,
  type CatalogDone,
  type CatalogFile,
  type CatalogModel,
  type CatalogProgress,
} from "../../lib/api";
import { log } from "../../lib/logger";
import type { AppStore } from "../store";

// ── Failure copy ─────────────────────────────────────────────────────────────
// Every catalog failure the user can see goes through `humanizeCatalogError`.
// Raw exception text ("Cannot read properties of undefined (reading 'invoke')",
// "403 — access to this model is restricted…") is developer-facing: it goes to
// the logger, while the UI gets one sentence naming the cause AND the fix.

/** Coarse cause of a catalog failure — drives the copy and the offered remedy. */
export type CatalogErrorKind =
  | "auth"
  | "rate-limit"
  | "not-found"
  | "offline"
  | "server"
  | "disk"
  | "engine"
  | "app"
  | "unknown";

/** A failure translated for the UI. Never carries raw exception text. */
export type CatalogFailureUi = { kind: CatalogErrorKind; message: string };

/** `CatalogFailureUi` plus the raw thrown text — for `log.*` meta only. */
export type CatalogFailure = CatalogFailureUi & { raw: string };

const COPY: Record<Exclude<CatalogErrorKind, "auth">, string> = {
  "rate-limit":
    "HuggingFace is rate-limiting this app — wait a minute and retry, or add an access token under Token to raise the limit.",
  "not-found":
    "That repo or file is no longer on HuggingFace — it was renamed or removed. Run the search again to refresh the list.",
  offline: "Couldn't reach huggingface.co — check your internet connection, then retry.",
  server: "HuggingFace couldn't answer that request — wait a few minutes, then retry.",
  disk: "Couldn't write into your models folder — free up disk space or pick another folder in Configure, then retry.",
  engine:
    "Couldn't run hipfire — install it or fix the hipfire binary path in Configure, then retry.",
  app: "The app couldn't reach its own backend — restart the app, then try again.",
  unknown: "Something went wrong — retry, and open the Logs panel for the details.",
};

const AUTH_TOKEN_REJECTED =
  "HuggingFace rejected the access token saved in this app — open Token and paste a valid read token from huggingface.co/settings/tokens.";
const AUTH_NO_TOKEN =
  "HuggingFace refused this request — the repo is gated or private. Accept its terms on huggingface.co, then add a read token under Token.";

/**
 * Map an unknown thrown value to a user-facing sentence with a remedy, keeping
 * the raw text for the logs. `hasToken` decides the 401/403 wording: with a
 * token saved the credentials themselves are what HuggingFace rejected, so say
 * that plainly instead of blaming the network or the search.
 */
export function humanizeCatalogError(
  e: unknown,
  opts: { hasToken?: boolean } = {},
): CatalogFailure {
  const raw = e instanceof Error ? e.message : String(e);
  const t = raw.toLowerCase();
  const as = (kind: CatalogErrorKind, message: string): CatalogFailure => ({ kind, message, raw });

  // Our own bridge is gone or the command panicked — retrying won't help.
  if (t.includes("invoke") || t.includes("__tauri") || t.includes("task failed"))
    return as("app", COPY.app);
  // The hipfire panel shells out to the CLI; those failures are never HF's.
  if (t.includes("hipfire")) return as("engine", COPY.engine);
  if (/\b40[13]\b/.test(t) || t.includes("unauthorized") || t.includes("forbidden"))
    return as("auth", opts.hasToken ? AUTH_TOKEN_REJECTED : AUTH_NO_TOKEN);
  if (t.includes("429") || t.includes("rate limit")) return as("rate-limit", COPY["rate-limit"]);
  if (/\b404\b/.test(t)) return as("not-found", COPY["not-found"]);
  if (
    /status code 5\d\d/.test(t) ||
    t.includes("parse search json") ||
    t.includes("parse tree json")
  )
    return as("server", COPY.server);
  if (t.includes("incomplete download"))
    return as(
      "offline",
      "The download stopped before the file was complete — check your connection, then retry.",
    );
  if (
    t.includes("no space") ||
    t.includes("not enough space") ||
    t.includes("disk full") ||
    t.includes("os error 112") ||
    t.includes("mkdir") ||
    t.includes("finalize")
  )
    return as("disk", COPY.disk);
  if (
    t.includes("offline") ||
    t.includes("dns") ||
    t.includes("network") ||
    t.includes("timed out") ||
    t.includes("timeout") ||
    t.includes("unreachable") ||
    t.includes("connect") ||
    t.includes("request failed")
  )
    return as("offline", COPY.offline);
  return as("unknown", COPY.unknown);
}

/** Drop the raw text — state, and therefore the UI, only holds the human copy. */
const toUi = (f: CatalogFailure): CatalogFailureUi => ({ kind: f.kind, message: f.message });

/** Live state of the (single) in-flight model download. */
export type CatalogDownloadUi = {
  generation: number;
  repoId: string;
  filename: string;
  downloaded: number;
  total: number;
  /** 1-based index of the part currently downloading. */
  part: number;
  parts: number;
  /** The catalog entry being fetched — kept so a failure can offer a Retry. */
  file: CatalogFile;
};

/** Per-repo file list: a loaded array, or a sentinel while in flight / failed. */
export type CatalogFilesState = CatalogFile[] | "loading" | { failed: CatalogFailureUi };

/**
 * Which operation produced the banner error, so its Retry re-runs the thing
 * that actually failed. `none` is a failure with nothing to re-run (a terminal
 * download event that arrived with no in-flight state) — the UI hides Retry.
 */
export type CatalogErrorSource =
  | { op: "search" }
  | { op: "download"; repoId: string; file: CatalogFile }
  | { op: "none" };

/** The banner error: humanized copy plus the operation Retry should re-run. */
export type CatalogErrorUi = CatalogFailureUi & { source: CatalogErrorSource };

/** Drop the banner only when the op that just succeeded is the one that failed. */
function clearedAfter(
  cur: CatalogErrorUi | null,
  op: CatalogErrorSource["op"],
): CatalogErrorUi | null {
  return cur && cur.source.op === op ? null : cur;
}

export type CatalogSlice = {
  /** Models returned by the last search. */
  catalogResults: CatalogModel[];
  catalogSearching: boolean;
  catalogError: CatalogErrorUi | null;
  /** Whether a search has completed at least once (drives the empty state). */
  catalogSearched: boolean;
  catalogQuery: string;
  catalogSort: string;
  /** Lazily-fetched quant lists, keyed by repo id. */
  catalogFiles: Record<string, CatalogFilesState>;
  /** Non-null while a download is in flight. */
  catalogDownload: CatalogDownloadUi | null;

  searchCatalog: (query?: string) => Promise<void>;
  /** Re-run whatever operation the banner error came from. */
  retryCatalogError: () => Promise<void>;
  setCatalogQuery: (query: string) => void;
  setCatalogSort: (sort: string) => Promise<void>;
  setHfToken: (token: string) => Promise<void>;
  loadCatalogFiles: (repoId: string) => Promise<void>;
  startCatalogDownload: (repoId: string, file: CatalogFile) => Promise<void>;
  cancelCatalogDownload: () => Promise<void>;
  catalogOnProgress: (ev: CatalogProgress) => void;
  catalogOnDone: (ev: CatalogDone) => void;
};

export const createCatalogSlice: StateCreator<AppStore, [], [], CatalogSlice> = (set, get) => ({
  catalogResults: [],
  catalogSearching: false,
  catalogError: null,
  catalogSearched: false,
  catalogQuery: "",
  catalogSort: "downloads",
  catalogFiles: {},
  catalogDownload: null,

  searchCatalog: async (query) => {
    const q = query ?? get().catalogQuery;
    // The banner is deliberately NOT cleared here: clearing on the way in makes
    // a failing retry look like it worked for as long as the request is in
    // flight. It clears below, once the search has actually succeeded.
    set({ catalogSearching: true });
    log.info("catalog", `searching "${q}" sort=${get().catalogSort}`);
    try {
      const results = await api.searchCatalog(q, get().catalogSort, 40, get().settings.hf_token);
      set({
        catalogResults: results,
        catalogSearched: true,
        catalogError: clearedAfter(get().catalogError, "search"),
      });
      log.info("catalog", `found ${results.length} models`);
    } catch (e: unknown) {
      const f = humanizeCatalogError(e, { hasToken: !!get().settings.hf_token });
      log.error("catalog", "search failed", { error: f.raw });
      set({ catalogError: { ...toUi(f), source: { op: "search" } }, catalogSearched: true });
    } finally {
      set({ catalogSearching: false });
    }
  },

  retryCatalogError: async () => {
    const src = get().catalogError?.source;
    if (src?.op === "search") await get().searchCatalog();
    else if (src?.op === "download") await get().startCatalogDownload(src.repoId, src.file);
  },

  setCatalogQuery: (query) => set({ catalogQuery: query }),

  setCatalogSort: async (sort) => {
    set({ catalogSort: sort });
    await get().searchCatalog();
  },

  setHfToken: async (token) => {
    const trimmed = token.trim();
    const next = get().patchSettings({ hf_token: trimmed === "" ? null : trimmed });
    await api.saveSettings(next);
    log.info("catalog", trimmed === "" ? "HF token cleared" : "HF token saved");
  },

  loadCatalogFiles: async (repoId) => {
    const cur = get().catalogFiles[repoId];
    // Re-fetch on a prior error; skip if already loaded or in flight.
    if (Array.isArray(cur) || cur === "loading") return;
    set((s) => ({ catalogFiles: { ...s.catalogFiles, [repoId]: "loading" } }));
    try {
      const files = await api.listCatalogFiles(repoId, get().settings.hf_token);
      set((s) => ({ catalogFiles: { ...s.catalogFiles, [repoId]: files } }));
      log.info("catalog", `${repoId} → ${files.length} quants`);
    } catch (e: unknown) {
      const f = humanizeCatalogError(e, { hasToken: !!get().settings.hf_token });
      log.warn("catalog", `list files failed for ${repoId}`, { error: f.raw });
      // The reason (and a Retry for this repo) is kept with the repo rather
      // than pushed into the shared banner, which would lose which repo failed.
      set((s) => ({ catalogFiles: { ...s.catalogFiles, [repoId]: { failed: toUi(f) } } }));
    }
  },

  startCatalogDownload: async (repoId, file) => {
    if (get().catalogDownload) {
      log.warn("catalog", "download ignored: one is already running");
      return;
    }
    set({
      catalogDownload: {
        generation: 0,
        repoId,
        filename: file.filename,
        downloaded: 0,
        total: file.size,
        part: 0,
        parts: file.n_parts,
        file,
      },
    });
    log.info("catalog", `downloading ${repoId}/${file.filename}`, { parts: file.n_parts });
    try {
      const modelsDir = get().settings.models_dir ?? null;
      const generation = await api.downloadCatalogModel(
        repoId,
        file,
        modelsDir,
        get().settings.hf_token,
      );
      set((s) =>
        s.catalogDownload ? { catalogDownload: { ...s.catalogDownload, generation } } : {},
      );
    } catch (e: unknown) {
      const f = humanizeCatalogError(e, { hasToken: !!get().settings.hf_token });
      const message = `Download failed: ${file.filename}. ${f.message}`;
      log.error("catalog", "download failed to start", { error: f.raw });
      // Toast it, same as the terminal-failure path below: the user may have
      // navigated away between clicking Get and the backend rejecting.
      log.notify("error", "catalog", message);
      set({
        catalogDownload: null,
        catalogError: { kind: f.kind, message, source: { op: "download", repoId, file } },
      });
    }
  },

  cancelCatalogDownload: async () => {
    log.info("catalog", "cancel requested");
    try {
      await api.cancelCatalogDownload();
    } catch (e: unknown) {
      log.error("catalog", "cancel failed", { error: String(e) });
    }
  },

  catalogOnProgress: (ev) => {
    const cur = get().catalogDownload;
    if (!cur) return;
    // Spread the current entry so the `file` (the Retry payload) survives.
    set({
      catalogDownload: {
        ...cur,
        generation: ev.generation,
        repoId: ev.repo_id,
        filename: ev.filename,
        downloaded: ev.downloaded,
        total: ev.total,
        part: ev.part,
        parts: ev.parts,
      },
    });
  },

  catalogOnDone: (ev) => {
    if (ev.cancelled) {
      log.info("catalog", "download cancelled");
      set({ catalogDownload: null, catalogError: clearedAfter(get().catalogError, "download") });
      return;
    }
    if (!ev.ok) {
      const f = humanizeCatalogError(ev.error ?? "download failed", {
        hasToken: !!get().settings.hf_token,
      });
      const inFlight = get().catalogDownload;
      const message = `Download failed: ${ev.filename}. ${f.message}`;
      log.error("catalog", "download failed", { error: f.raw });
      // Announce it the way the success path does. A multi-GB download can die
      // long after the user left the Catalog screen, where the banner below is
      // invisible — without this toast the failure is reported nowhere.
      log.notify("error", "catalog", message);
      set({
        catalogDownload: null,
        catalogError: {
          kind: f.kind,
          message,
          source: inFlight
            ? { op: "download", repoId: ev.repo_id, file: inFlight.file }
            : { op: "none" },
        },
      });
      return;
    }
    log.info("catalog", `downloaded ${ev.repo_id}/${ev.filename}`);
    // Confirm completion — the download panel just vanishes otherwise, leaving
    // no sign the (often long) download actually finished.
    log.notify("info", "catalog", `Downloaded ${ev.filename} — added to your library`);
    set({ catalogDownload: null, catalogError: clearedAfter(get().catalogError, "download") });
    // Make the new file show up in the Models library. The backend reports the
    // dir the file actually landed in (dest_root) — the configured models_dir,
    // or the app-data fallback when none was set. If that differs from the
    // current models_dir (no dir set, or it changed mid-download), adopt the
    // landing dir so the scan targets where the file really is; else just rescan.
    const root = ev.dest_root;
    const modelsDir = get().settings.models_dir;
    if (root && root !== modelsDir) {
      void get().setModelsDir(root);
    } else {
      void get().rescanModels();
    }
  },
});
