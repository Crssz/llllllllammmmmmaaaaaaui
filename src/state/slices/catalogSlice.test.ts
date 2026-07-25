import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, type CatalogFile, type CatalogModel } from "../../lib/api";
import { log } from "../../lib/logger";
import { flush, freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";
import { humanizeCatalogError } from "./catalogSlice";

const MODEL: CatalogModel = {
  id: "owner/Foo-GGUF",
  owner: "owner",
  name: "Foo-GGUF",
  downloads: 1234,
  likes: 5,
  gated: false,
  gated_kind: null,
  pipeline_tag: "text-generation",
  library_name: "gguf",
  last_modified: null,
  tags: ["gguf"],
  gguf_count: 2,
  params: "7B",
};

const FILE: CatalogFile = {
  filename: "Foo-Q4_K_M.gguf",
  tag: "Q4_K_M",
  bits: 4,
  size: 4_000_000_000,
  size_gb: 3.7,
  badges: [],
  is_split: false,
  n_parts: 1,
  url_paths: ["Foo-Q4_K_M.gguf"],
  is_mmproj: false,
};

describe("catalog slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("searchCatalog populates results and marks searched", async () => {
    vi.spyOn(api, "searchCatalog").mockResolvedValueOnce([MODEL]);
    await useAppStore.getState().searchCatalog("foo");
    const s = useAppStore.getState();
    expect(s.catalogResults).toHaveLength(1);
    expect(s.catalogSearched).toBe(true);
    expect(s.catalogSearching).toBe(false);
    expect(s.catalogError).toBeNull();
  });

  it("searchCatalog surfaces a humanized error but still marks searched", async () => {
    vi.spyOn(api, "searchCatalog").mockRejectedValueOnce(new Error("offline"));
    await useAppStore.getState().searchCatalog("foo");
    const s = useAppStore.getState();
    expect(s.catalogError?.kind).toBe("offline");
    expect(s.catalogError?.message).toContain("check your internet connection");
    expect(s.catalogError?.source.op).toBe("search");
    expect(s.catalogSearched).toBe(true);
  });

  it("searchCatalog reports a rejected token as a token problem, not a search problem", async () => {
    useAppStore.getState().setSettings(makeSettings({ hf_token: "hf_typo" }));
    vi.spyOn(api, "searchCatalog").mockRejectedValueOnce(
      new Error("401 — this model is gated or private."),
    );
    await useAppStore.getState().searchCatalog("foo");
    const err = useAppStore.getState().catalogError;
    expect(err?.kind).toBe("auth");
    expect(err?.message).toContain("rejected the access token");
    expect(err?.message).toContain("huggingface.co/settings/tokens");
    // Raw backend text never reaches the UI copy.
    expect(err?.message).not.toContain("401");
  });

  it("searchCatalog keeps the error until a retry actually succeeds", async () => {
    const spy = vi
      .spyOn(api, "searchCatalog")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([MODEL]);
    await useAppStore.getState().searchCatalog("foo");
    expect(useAppStore.getState().catalogError).not.toBeNull();
    // Mid-retry the banner must still be up — clearing on the way in makes a
    // failing retry look like it worked.
    const inFlight = useAppStore.getState().retryCatalogError();
    expect(useAppStore.getState().catalogError).not.toBeNull();
    await inFlight;
    expect(useAppStore.getState().catalogError).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retryCatalogError re-runs the failed download rather than the search", async () => {
    vi.spyOn(api, "downloadCatalogModel").mockRejectedValueOnce(new Error("disk full"));
    await useAppStore.getState().startCatalogDownload("owner/Foo-GGUF", FILE);
    const search = vi.spyOn(api, "searchCatalog");
    const download = vi.spyOn(api, "downloadCatalogModel").mockResolvedValue(9);
    await useAppStore.getState().retryCatalogError();
    expect(search).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith("owner/Foo-GGUF", FILE, null, null);
  });

  it("setCatalogSort updates sort and re-searches with it", async () => {
    const spy = vi.spyOn(api, "searchCatalog").mockResolvedValue([]);
    await useAppStore.getState().setCatalogSort("likes");
    expect(useAppStore.getState().catalogSort).toBe("likes");
    expect(spy).toHaveBeenCalledWith(expect.anything(), "likes", expect.anything(), null);
  });

  it("searchCatalog forwards the saved HF token", async () => {
    useAppStore.getState().setSettings(makeSettings({ hf_token: "hf_secret" }));
    const spy = vi.spyOn(api, "searchCatalog").mockResolvedValue([]);
    await useAppStore.getState().searchCatalog("qwen");
    expect(spy).toHaveBeenCalledWith("qwen", expect.anything(), expect.anything(), "hf_secret");
  });

  it("setHfToken trims and persists, and clears to null on empty", async () => {
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(undefined);
    await useAppStore.getState().setHfToken("  hf_abc123  ");
    expect(useAppStore.getState().settings.hf_token).toBe("hf_abc123");
    expect(save).toHaveBeenCalled();
    await useAppStore.getState().setHfToken("   ");
    expect(useAppStore.getState().settings.hf_token).toBeNull();
  });

  it("loadCatalogFiles caches results and skips a second fetch", async () => {
    const spy = vi.spyOn(api, "listCatalogFiles").mockResolvedValue([FILE]);
    await useAppStore.getState().loadCatalogFiles("owner/Foo-GGUF");
    expect(useAppStore.getState().catalogFiles["owner/Foo-GGUF"]).toEqual([FILE]);
    await useAppStore.getState().loadCatalogFiles("owner/Foo-GGUF");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("loadCatalogFiles records a humanized reason on failure, and retries clear it", async () => {
    const spy = vi
      .spyOn(api, "listCatalogFiles")
      .mockRejectedValueOnce(new Error("429 — HuggingFace rate limit reached."))
      .mockResolvedValueOnce([FILE]);
    await useAppStore.getState().loadCatalogFiles("owner/Foo-GGUF");
    const failed = useAppStore.getState().catalogFiles["owner/Foo-GGUF"];
    expect(failed).toEqual({ failed: { kind: "rate-limit", message: expect.any(String) } });
    // The failed sentinel must not block a retry of that same repo.
    await useAppStore.getState().loadCatalogFiles("owner/Foo-GGUF");
    expect(useAppStore.getState().catalogFiles["owner/Foo-GGUF"]).toEqual([FILE]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("startCatalogDownload sets the in-flight UI and forwards the models dir", async () => {
    useAppStore.getState().setSettings(makeSettings({ models_dir: "/models" }));
    const spy = vi.spyOn(api, "downloadCatalogModel").mockResolvedValue(7);
    await useAppStore.getState().startCatalogDownload("owner/Foo-GGUF", FILE);
    expect(spy).toHaveBeenCalledWith("owner/Foo-GGUF", FILE, "/models", null);
    const dl = useAppStore.getState().catalogDownload;
    expect(dl?.repoId).toBe("owner/Foo-GGUF");
    expect(dl?.generation).toBe(7);
  });

  it("startCatalogDownload ignores a second concurrent request", async () => {
    const spy = vi.spyOn(api, "downloadCatalogModel").mockResolvedValue(1);
    useAppStore.setState({
      catalogDownload: {
        generation: 1,
        repoId: "x/y",
        filename: "a.gguf",
        downloaded: 0,
        total: 1,
        part: 1,
        parts: 1,
        file: FILE,
      },
    });
    await useAppStore.getState().startCatalogDownload("owner/Foo-GGUF", FILE);
    expect(spy).not.toHaveBeenCalled();
  });

  it("catalogOnProgress only updates while a download is active", () => {
    const ev = {
      generation: 1,
      repo_id: "owner/Foo-GGUF",
      filename: "Foo-Q4_K_M.gguf",
      downloaded: 100,
      total: 200,
      part: 1,
      parts: 1,
    };
    // No active download → ignored.
    useAppStore.getState().catalogOnProgress(ev);
    expect(useAppStore.getState().catalogDownload).toBeNull();
    // With an active download → applied.
    useAppStore.setState({
      catalogDownload: {
        generation: 1,
        repoId: "owner/Foo-GGUF",
        filename: "Foo-Q4_K_M.gguf",
        downloaded: 0,
        total: 200,
        part: 1,
        parts: 1,
        file: FILE,
      },
    });
    useAppStore.getState().catalogOnProgress(ev);
    expect(useAppStore.getState().catalogDownload?.downloaded).toBe(100);
  });

  it("catalogOnDone (cancelled) clears state without an error", () => {
    useAppStore.setState({
      catalogDownload: {
        generation: 1,
        repoId: "x/y",
        filename: "a.gguf",
        downloaded: 1,
        total: 2,
        part: 1,
        parts: 1,
        file: FILE,
      },
    });
    useAppStore.getState().catalogOnDone({
      generation: 1,
      repo_id: "x/y",
      filename: "a.gguf",
      ok: false,
      cancelled: true,
      error: null,
      dest_root: null,
      model_path: null,
    });
    expect(useAppStore.getState().catalogDownload).toBeNull();
    expect(useAppStore.getState().catalogError).toBeNull();
  });

  it("catalogOnDone (failure) surfaces a humanized error naming the file", () => {
    useAppStore.getState().catalogOnDone({
      generation: 1,
      repo_id: "x/y",
      filename: "a.gguf",
      ok: false,
      cancelled: false,
      error: "disk full",
      dest_root: null,
      model_path: null,
    });
    const err = useAppStore.getState().catalogError;
    expect(err?.kind).toBe("disk");
    expect(err?.message).toContain("a.gguf");
    expect(err?.message).toContain("free up disk space");
    // Nothing to re-run: the terminal event arrived with no in-flight state.
    expect(err?.source.op).toBe("none");
  });

  it("catalogOnDone (failure) toasts so the failure is visible off-screen", () => {
    const notify = vi.spyOn(log, "notify");
    useAppStore.setState({
      catalogDownload: {
        generation: 1,
        repoId: "owner/Foo-GGUF",
        filename: "Foo-Q4_K_M.gguf",
        downloaded: 1,
        total: 2,
        part: 1,
        parts: 1,
        file: FILE,
      },
    });
    useAppStore.getState().catalogOnDone({
      generation: 1,
      repo_id: "owner/Foo-GGUF",
      filename: "Foo-Q4_K_M.gguf",
      ok: false,
      cancelled: false,
      error: "connection reset",
      dest_root: null,
      model_path: null,
    });
    expect(notify).toHaveBeenCalledWith(
      "error",
      "catalog",
      expect.stringContaining("Foo-Q4_K_M.gguf"),
    );
    // The in-flight entry is remembered so the banner's Retry can re-run it.
    expect(useAppStore.getState().catalogError?.source).toEqual({
      op: "download",
      repoId: "owner/Foo-GGUF",
      file: FILE,
    });
  });

  it("catalogOnDone (success) rescans when a models dir is already set", () => {
    useAppStore.getState().setSettings(makeSettings({ models_dir: "/models" }));
    const scan = vi.spyOn(api, "scanModels");
    const adopt = vi.spyOn(api, "addRecentModelsDir");
    useAppStore.getState().catalogOnDone({
      generation: 1,
      repo_id: "owner/Foo-GGUF",
      filename: "Foo-Q4_K_M.gguf",
      ok: true,
      cancelled: false,
      error: null,
      dest_root: "/models",
      model_path: "/models/owner/Foo-GGUF/Foo-Q4_K_M.gguf",
    });
    expect(scan).toHaveBeenCalledWith("/models");
    expect(adopt).not.toHaveBeenCalled();
  });

  it("catalogOnDone (success) toasts that the file was added to the library", () => {
    useAppStore.getState().setSettings(makeSettings({ models_dir: "/models" }));
    const notify = vi.spyOn(log, "notify");
    useAppStore.getState().catalogOnDone({
      generation: 1,
      repo_id: "owner/Foo-GGUF",
      filename: "Foo-Q4_K_M.gguf",
      ok: true,
      cancelled: false,
      error: null,
      dest_root: "/models",
      model_path: "/models/owner/Foo-GGUF/Foo-Q4_K_M.gguf",
    });
    expect(notify).toHaveBeenCalledWith(
      "info",
      "catalog",
      expect.stringContaining("Foo-Q4_K_M.gguf"),
    );
  });

  it("catalogOnDone (success) adopts the fallback root and scans it when no models dir is set", async () => {
    const adopt = vi.spyOn(api, "addRecentModelsDir").mockResolvedValue(makeSettings());
    const scan = vi.spyOn(api, "scanModels");
    useAppStore.getState().catalogOnDone({
      generation: 1,
      repo_id: "owner/Foo-GGUF",
      filename: "Foo-Q4_K_M.gguf",
      ok: true,
      cancelled: false,
      error: null,
      dest_root: "/appdata/models",
      model_path: "/appdata/models/owner/Foo-GGUF/Foo-Q4_K_M.gguf",
    });
    // setModelsDir adopts the dir, then scans it — the scan is what actually
    // surfaces the new model, so await the fire-and-forget chain and assert it.
    await flush();
    await flush();
    expect(adopt).toHaveBeenCalledWith("/appdata/models");
    expect(scan).toHaveBeenCalledWith("/appdata/models");
  });

  it("catalogOnDone (success) adopts dest_root when it differs from the current models dir", () => {
    // Models dir was changed mid-download; the file actually landed elsewhere
    // (dest_root), so we must adopt where it is rather than rescan the new dir.
    useAppStore.getState().setSettings(makeSettings({ models_dir: "/changed" }));
    const adopt = vi.spyOn(api, "addRecentModelsDir").mockResolvedValue(makeSettings());
    useAppStore.getState().catalogOnDone({
      generation: 1,
      repo_id: "owner/Foo-GGUF",
      filename: "Foo-Q4_K_M.gguf",
      ok: true,
      cancelled: false,
      error: null,
      dest_root: "/appdata/models",
      model_path: "/appdata/models/owner/Foo-GGUF/Foo-Q4_K_M.gguf",
    });
    expect(adopt).toHaveBeenCalledWith("/appdata/models");
  });

  it("startCatalogDownload clears the in-flight UI and surfaces the error when the backend rejects", async () => {
    vi.spyOn(api, "downloadCatalogModel").mockRejectedValueOnce(new Error("disk full"));
    await useAppStore.getState().startCatalogDownload("owner/Foo-GGUF", FILE);
    const s = useAppStore.getState();
    expect(s.catalogDownload).toBeNull();
    expect(s.catalogError?.kind).toBe("disk");
    expect(s.catalogError?.message).toContain(FILE.filename);
    expect(s.catalogError?.source).toEqual({
      op: "download",
      repoId: "owner/Foo-GGUF",
      file: FILE,
    });
  });

  it("catalogOnProgress overwrites identity fields from the event while active", () => {
    useAppStore.setState({
      catalogDownload: {
        generation: 1,
        repoId: "owner/Foo-GGUF",
        filename: "Foo-Q4_K_M.gguf",
        downloaded: 0,
        total: 200,
        part: 1,
        parts: 3,
        file: FILE,
      },
    });
    useAppStore.getState().catalogOnProgress({
      generation: 2,
      repo_id: "owner/Bar-GGUF",
      filename: "Bar-00002-of-00003.gguf",
      downloaded: 150,
      total: 300,
      part: 2,
      parts: 3,
    });
    const dl = useAppStore.getState().catalogDownload;
    expect(dl?.generation).toBe(2);
    expect(dl?.repoId).toBe("owner/Bar-GGUF");
    expect(dl?.filename).toBe("Bar-00002-of-00003.gguf");
    expect(dl?.part).toBe(2);
    // …but the Retry payload survives them.
    expect(dl?.file).toEqual(FILE);
  });

  it("humanizeCatalogError never returns raw exception text", () => {
    // The exact string the Catalog screen was caught rendering.
    const bridge = humanizeCatalogError(
      new TypeError("Cannot read properties of undefined (reading 'invoke')"),
    );
    expect(bridge.kind).toBe("app");
    expect(bridge.message).toBe(
      "The app couldn't reach its own backend — restart the app, then try again.",
    );
    expect(bridge.raw).toContain("invoke");

    // Every branch ends in a sentence with a remedy, and none echo the input.
    for (const raw of [
      "403 — access to this model is restricted",
      "429 — HuggingFace rate limit reached.",
      "404 — not found (the repo or file may have moved).",
      "request failed: https://huggingface.co/api/models: status code 503",
      "incomplete download: got 12 of 4000 expected bytes",
      "hipfire not found on PATH",
      "something nobody predicted",
    ]) {
      const f = humanizeCatalogError(raw);
      expect(f.message).not.toContain(raw);
      expect(f.message).toMatch(/—/);
      expect(f.raw).toBe(raw);
    }
  });

  it("humanizeCatalogError blames the repo, not the token, when none is saved", () => {
    expect(humanizeCatalogError("401 — gated", { hasToken: false }).message).toContain(
      "gated or private",
    );
    expect(humanizeCatalogError("401 — gated", { hasToken: true }).message).toContain(
      "rejected the access token",
    );
  });
});
