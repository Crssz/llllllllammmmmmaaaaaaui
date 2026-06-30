import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, type CatalogFile, type CatalogModel } from "../../lib/api";
import { flush, freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";

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

  it("searchCatalog surfaces errors but still marks searched", async () => {
    vi.spyOn(api, "searchCatalog").mockRejectedValueOnce(new Error("offline"));
    await useAppStore.getState().searchCatalog("foo");
    const s = useAppStore.getState();
    expect(s.catalogError).toBe("offline");
    expect(s.catalogSearched).toBe(true);
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

  it("loadCatalogFiles records an error sentinel on failure", async () => {
    vi.spyOn(api, "listCatalogFiles").mockRejectedValueOnce(new Error("nope"));
    await useAppStore.getState().loadCatalogFiles("owner/Foo-GGUF");
    expect(useAppStore.getState().catalogFiles["owner/Foo-GGUF"]).toBe("error");
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

  it("catalogOnDone (failure) surfaces the error", () => {
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
    expect(useAppStore.getState().catalogError).toBe("disk full");
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
    expect(s.catalogError).toBe("disk full");
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
  });
});
