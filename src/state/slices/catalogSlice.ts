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
};

/** Per-repo file list: a loaded array, or a sentinel while in flight / failed. */
export type CatalogFilesState = CatalogFile[] | "loading" | "error";

export type CatalogSlice = {
  /** Models returned by the last search. */
  catalogResults: CatalogModel[];
  catalogSearching: boolean;
  catalogError: string | null;
  /** Whether a search has completed at least once (drives the empty state). */
  catalogSearched: boolean;
  catalogQuery: string;
  catalogSort: string;
  /** Lazily-fetched quant lists, keyed by repo id. */
  catalogFiles: Record<string, CatalogFilesState>;
  /** Non-null while a download is in flight. */
  catalogDownload: CatalogDownloadUi | null;

  searchCatalog: (query?: string) => Promise<void>;
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
    set({ catalogSearching: true, catalogError: null });
    log.info("catalog", `searching "${q}" sort=${get().catalogSort}`);
    try {
      const results = await api.searchCatalog(q, get().catalogSort, 40, get().settings.hf_token);
      set({ catalogResults: results, catalogSearched: true });
      log.info("catalog", `found ${results.length} models`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("catalog", "search failed", { error: msg });
      set({ catalogError: msg, catalogSearched: true });
    } finally {
      set({ catalogSearching: false });
    }
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
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("catalog", `list files failed for ${repoId}`, { error: msg });
      set((s) => ({ catalogFiles: { ...s.catalogFiles, [repoId]: "error" } }));
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
      },
      catalogError: null,
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
      const msg = e instanceof Error ? e.message : String(e);
      log.error("catalog", "download failed to start", { error: msg });
      set({ catalogDownload: null, catalogError: msg });
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
    if (!get().catalogDownload) return;
    set({
      catalogDownload: {
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
      set({ catalogDownload: null, catalogError: null });
      return;
    }
    if (!ev.ok) {
      const error = ev.error ?? "Download failed.";
      log.error("catalog", "download failed", { error });
      set({ catalogDownload: null, catalogError: error });
      return;
    }
    log.info("catalog", `downloaded ${ev.repo_id}/${ev.filename}`);
    set({ catalogDownload: null, catalogError: null });
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
