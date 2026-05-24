import { describe, it, expect, beforeEach } from "vitest";
import { api } from "../../lib/api";
import { freshStore, makeSettings, stubApi, useAppStore } from "../testUtils";

describe("profiles slice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });

  it("saveProfile pushes a new entry capped at 50", async () => {
    const seed = makeSettings({
      profiles: Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        name: `p${i}`,
        created_at: i,
        flags: {},
        model_path: null,
        agency: null,
      })),
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

  it("loadProfile applies flags + agency", () => {
    useAppStore.getState().setSettings(
      makeSettings({
        profiles: [
          {
            id: "p1",
            name: "n",
            created_at: 1,
            flags: { ctx: 1024 },
            model_path: "/m/x.gguf",
            agency: "auto",
          },
        ],
      }),
    );
    useAppStore.getState().loadProfile("p1");
    expect(useAppStore.getState().flags.ctx).toBe(1024);
    expect(useAppStore.getState().flags.model).toBe("/m/x.gguf");
    expect(useAppStore.getState().agency).toBe("auto");
  });

  it("loadProfile no-ops on unknown id", () => {
    useAppStore.getState().resetFlags({ ctx: 2048 });
    useAppStore.getState().loadProfile("nope");
    expect(useAppStore.getState().flags.ctx).toBe(2048);
  });

  it("loadProfile ignores invalid agency values", () => {
    useAppStore.getState().setSettings(
      makeSettings({
        profiles: [
          {
            id: "p1",
            name: "n",
            created_at: 1,
            flags: {},
            model_path: null,
            agency: "garbage",
          },
        ],
      }),
    );
    useAppStore.getState().setAgency("manual");
    useAppStore.getState().loadProfile("p1");
    expect(useAppStore.getState().agency).toBe("manual");
  });

  it("deleteProfile removes by id and persists", async () => {
    useAppStore.getState().setSettings(
      makeSettings({
        profiles: [
          { id: "a", name: "a", created_at: 1, flags: {}, model_path: null, agency: null },
          { id: "b", name: "b", created_at: 2, flags: {}, model_path: null, agency: null },
        ],
      }),
    );
    await useAppStore.getState().deleteProfile("a");
    const left = useAppStore.getState().settings.profiles;
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe("b");
  });
});
