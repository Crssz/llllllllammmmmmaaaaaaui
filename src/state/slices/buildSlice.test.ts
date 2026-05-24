import { describe, it, expect, beforeEach, vi } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("build slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("scanBuild populates state on success", async () => {
    await useAppStore.getState().scanBuild("/b");
    const s = useAppStore.getState();
    expect(s.scanning).toBe(false);
    expect(s.build?.detected).toBe(true);
    expect(s.scanError).toBeNull();
  });

  it("scanBuild records error on failure", async () => {
    vi.spyOn(api, "scanBuild").mockRejectedValueOnce(new Error("no such dir"));
    await useAppStore.getState().scanBuild("/missing");
    const s = useAppStore.getState();
    expect(s.scanError).toBe("no such dir");
    expect(s.scanning).toBe(false);
  });

  it("scanBuild ignores stale results when a newer scan starts", async () => {
    let resolveFirst: (v: never) => void = () => {};
    const first = new Promise((res) => {
      resolveFirst = res as never;
    });
    vi.spyOn(api, "scanBuild")
      .mockImplementationOnce(() => first as never)
      .mockResolvedValueOnce({
        path: "/b2",
        resolved_path: "/b2",
        detected: true,
        version: "v2",
        commit: null,
        backend_badges: [],
        binaries: [],
      });
    const p1 = useAppStore.getState().scanBuild("/b1");
    await useAppStore.getState().scanBuild("/b2");
    resolveFirst({
      path: "/b1",
      resolved_path: "/b1",
      detected: true,
      version: "v1",
      commit: null,
      backend_badges: [],
      binaries: [],
    } as never);
    await p1;
    expect(useAppStore.getState().build?.version).toBe("v2");
  });

  it("setBuildDir adds the dir to recents and triggers a scan", async () => {
    const updated = makeSettings({ build_dir: "/b", recent_dirs: ["/b"] });
    vi.spyOn(api, "addRecentDir").mockResolvedValueOnce(updated);
    await useAppStore.getState().setBuildDir("/b");
    expect(useAppStore.getState().settings.build_dir).toBe("/b");
    expect(api.scanBuild).toHaveBeenCalledWith("/b");
  });

  it("pickBuildDir no-ops when the dialog returns null", async () => {
    vi.spyOn(api, "pickFolder").mockResolvedValueOnce(null);
    await useAppStore.getState().pickBuildDir();
    expect(api.scanBuild).not.toHaveBeenCalled();
  });

  it("pickBuildDir cascades when the dialog returns a path", async () => {
    vi.spyOn(api, "pickFolder").mockResolvedValueOnce("/picked");
    const updated = makeSettings({ build_dir: "/picked", recent_dirs: ["/picked"] });
    vi.spyOn(api, "addRecentDir").mockResolvedValueOnce(updated);
    await useAppStore.getState().pickBuildDir();
    expect(useAppStore.getState().settings.build_dir).toBe("/picked");
  });

  it("rescan no-ops when there's no current build_dir", async () => {
    await useAppStore.getState().rescan();
    expect(api.scanBuild).not.toHaveBeenCalled();
  });

  it("rescan re-runs the scan when build_dir is set", async () => {
    useAppStore.getState().setSettings(makeSettings({ build_dir: "/b" }));
    await useAppStore.getState().rescan();
    expect(api.scanBuild).toHaveBeenCalledWith("/b");
  });
});
