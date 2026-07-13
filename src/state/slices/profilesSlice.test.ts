import { describe, it, expect, beforeEach } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeProfile, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("profiles slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("saveProfile pushes a new entry capped at 50", async () => {
    const seed = makeSettings({
      profiles: Array.from({ length: 50 }, (_, i) =>
        makeProfile({ id: String(i), name: `p${i}`, created_at: i }),
      ),
    });
    useAppStore.getState().setSettings(seed);
    useAppStore.getState().resetFlags({ ctx: 4096 });
    await useAppStore.getState().saveProfile("first");
    const profiles = useAppStore.getState().settings.profiles;
    expect(profiles).toHaveLength(50);
    expect(profiles[0].name).toBe("first");
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it("saveProfile defaults the name when empty", async () => {
    await useAppStore.getState().saveProfile("");
    expect(useAppStore.getState().settings.profiles[0].name).toBe("Untitled profile");
  });

  it("saveProfile snapshots the active engine + hipfire flag bag", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_path: "C:/hipfire/hipfire.exe",
        hipfire_flags: { tag: "qwen3.6:27b", port: 8090 },
      }),
    );
    await useAppStore.getState().saveProfile("hf");
    const p = useAppStore.getState().settings.profiles[0];
    expect(p.engine_kind).toBe("hipfire");
    expect(p.hipfire_flags).toEqual({ tag: "qwen3.6:27b", port: 8090 });
  });

  it("loadProfile applies flags + model path", () => {
    useAppStore.getState().setSettings(
      makeSettings({
        profiles: [
          makeProfile({
            id: "p1",
            name: "n",
            flags: { ctx: 1024 },
            model_path: "/m/x.gguf",
          }),
        ],
      }),
    );
    useAppStore.getState().loadProfile("p1");
    expect(useAppStore.getState().flags.ctx).toBe(1024);
    expect(useAppStore.getState().flags.model).toBe("/m/x.gguf");
    // Marks the loaded profile as active (non-persisted UI marker).
    expect(useAppStore.getState().loadedProfileId).toBe("p1");
  });

  it("loadProfile restores the profile's engine_kind", () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "llama",
        profiles: [
          makeProfile({
            id: "p1",
            engine_kind: "hipfire",
            hipfire_flags: { tag: "qwen3.6:27b" },
          }),
        ],
      }),
    );
    useAppStore.getState().loadProfile("p1");
    expect(useAppStore.getState().settings.engine_kind).toBe("hipfire");
    expect(useAppStore.getState().settings.hipfire_flags).toEqual({ tag: "qwen3.6:27b" });
  });

  it("loadProfile does not clobber current hipfire_flags when the profile is llama/legacy", () => {
    useAppStore.getState().setSettings(
      makeSettings({
        engine_kind: "hipfire",
        hipfire_flags: { tag: "keep-me" },
        profiles: [makeProfile({ id: "p1", engine_kind: "llama" })],
      }),
    );
    useAppStore.getState().loadProfile("p1");
    expect(useAppStore.getState().settings.engine_kind).toBe("llama");
    expect(useAppStore.getState().settings.hipfire_flags).toEqual({ tag: "keep-me" });
  });

  it("loadProfile no-ops on unknown id", () => {
    useAppStore.getState().resetFlags({ ctx: 2048 });
    useAppStore.getState().loadProfile("nope");
    expect(useAppStore.getState().flags.ctx).toBe(2048);
    expect(useAppStore.getState().loadedProfileId).toBeNull();
  });

  it("deleteProfile removes by id and persists", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        profiles: [makeProfile({ id: "a", name: "a" }), makeProfile({ id: "b", name: "b" })],
      }),
    );
    await useAppStore.getState().deleteProfile("a");
    const left = useAppStore.getState().settings.profiles;
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe("b");
  });

  it("renameProfile updates the name (with fallback) and persists", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        profiles: [makeProfile({ id: "a", name: "old" })],
      }),
    );
    await useAppStore.getState().renameProfile("a", "new");
    expect(useAppStore.getState().settings.profiles[0].name).toBe("new");
    await useAppStore.getState().renameProfile("a", "");
    expect(useAppStore.getState().settings.profiles[0].name).toBe("Untitled profile");
  });

  it("renameProfile no-ops (no save) on unknown id", async () => {
    await useAppStore.getState().renameProfile("nope", "x");
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("duplicateProfile prepends a copy with fresh id and copied flags", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        profiles: [makeProfile({ id: "a", name: "p", flags: { ctx: 2048 }, model_path: "/m" })],
      }),
    );
    await useAppStore.getState().duplicateProfile("a");
    const profiles = useAppStore.getState().settings.profiles;
    expect(profiles).toHaveLength(2);
    expect(profiles[0].id).not.toBe("a");
    expect(profiles[0].name).toBe("p (copy)");
    expect(profiles[0].flags).toEqual({ ctx: 2048 });
    expect(profiles[0].flags).not.toBe(profiles[1].flags);
    expect(profiles[0].model_path).toBe("/m");
  });

  it("duplicateProfile no-ops on unknown id", async () => {
    await useAppStore.getState().duplicateProfile("nope");
    expect(useAppStore.getState().settings.profiles).toHaveLength(0);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});
