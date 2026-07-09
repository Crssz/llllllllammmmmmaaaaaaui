import type { StateCreator } from "zustand";
import { api, type Settings } from "../../lib/api";
import { log } from "../../lib/logger";
import { defaultFlags } from "../../data";
import { resolveMmproj } from "../../lib/mmproj";
import type { FlagValues } from "../types";
import { persistSettings } from "../persist";
import type { AppStore } from "../store";

export type FlagsSlice = {
  flags: FlagValues;
  reasoningEnabled: boolean;
  setReasoningEnabled: (v: boolean) => void;
  setFlag: (key: string, value: string | number | boolean) => void;
  resetFlags: (values: FlagValues) => void;
  /** Open a file dialog to choose a GGUF and set it as `--model`. Resolves with
   *  the chosen path (so a caller can restart the server), or null if cancelled. */
  pickModel: () => Promise<string | null>;
  loadModelPath: (path: string) => void;
  /** Drop the current model's saved config and reset its flags to defaults.
   *  The escape hatch for the otherwise-automatic per-model persistence. */
  forgetModelConfig: () => void;
  /** Set `mmproj` explicitly for the current model and pin it, so the GGUF
   *  inspect effect stops auto-managing the projector for this model (a
   *  deliberately-cleared or out-of-folder projector now sticks across loads). */
  setMmproj: (path: string) => void;
  /** Re-enable auto-detection of `mmproj` for the current model. */
  unpinMmproj: () => void;
  /** Apply the projector auto-detect heuristic for the current model, unless
   *  the user has pinned mmproj for it. Driven by the GGUF inspect effect. */
  autoDetectMmproj: () => void;
};

/**
 * Maintain the per-model-config invariant while persisting `flags`.
 *
 * `model_configs[path]` always mirrors the latest flag set (minus the `model`
 * path key, which is the map key) for the currently-loaded model. Every flag
 * mutation routes through here, so loading a model later restores exactly the
 * config it had. When no model is loaded we only update the global `flags`.
 */
export function applyPerModel(settings: Settings, flags: FlagValues): Settings {
  const model = flags.model;
  if (typeof model !== "string" || !model) {
    return { ...settings, flags };
  }
  const { model: _omit, ...perModel } = flags;
  return {
    ...settings,
    flags,
    model_path: model,
    model_configs: { ...settings.model_configs, [model]: perModel },
  };
}

export const createFlagsSlice: StateCreator<AppStore, [], [], FlagsSlice> = (set, get) => ({
  flags: {},
  reasoningEnabled: true,

  setReasoningEnabled: (v) => {
    set({ reasoningEnabled: v });
    const updated = { ...get().settings, reasoning_enabled: v };
    get().setSettings(updated);
    persistSettings(updated);
    log.info("chat", `enable_thinking: ${v ? "on" : "off"}`);
  },

  setFlag: (key, value) => {
    const { flags, settings } = get();
    let next: FlagValues;
    if (key === "model" && typeof value === "string") {
      // Switching models: restore the new model's saved config (if any), then
      // pin the path. A saved slot is layered over factory defaults — not over
      // the outgoing model's flags — so a key the slot omits falls back to its
      // default instead of silently leaking (and re-persisting) the previous
      // model's value. With no saved config we keep the current flags so the
      // freshly-loaded model inherits them as its starting point.
      const saved = settings.model_configs?.[value] as FlagValues | undefined;
      next = saved
        ? { ...(defaultFlags() as FlagValues), ...saved, model: value }
        : { ...flags, model: value };
      if (saved) log.info("model", `restored saved config for ${value}`);
    } else {
      next = { ...flags, [key]: value };
    }
    set({ flags: next });
    const updated = applyPerModel(settings, next);
    get().setSettings(updated);
    persistSettings(updated);
  },

  resetFlags: (values) => {
    set({ flags: values });
    const updated = applyPerModel(get().settings, values);
    get().setSettings(updated);
    persistSettings(updated);
  },

  pickModel: async () => {
    const picked = await api.pickFile();
    if (picked) get().setFlag("model", picked);
    return picked;
  },

  loadModelPath: (path) => {
    get().setFlag("model", path);
  },

  forgetModelConfig: () => {
    const { flags, settings } = get();
    const model = flags.model as string | undefined;
    // Reset to factory defaults, keeping the model loaded.
    const next = defaultFlags() as FlagValues;
    if (model) next.model = model;
    else delete next.model;
    set({ flags: next });
    const model_configs = { ...settings.model_configs };
    if (model) delete model_configs[model];
    // Resetting also returns mmproj to auto-managed (drop any pin).
    const mmproj_pinned = model
      ? (settings.mmproj_pinned ?? []).filter((m) => m !== model)
      : (settings.mmproj_pinned ?? []);
    const updated: Settings = {
      ...settings,
      flags: next,
      model_path: model ?? settings.model_path,
      model_configs,
      mmproj_pinned,
    };
    get().setSettings(updated);
    persistSettings(updated);
    if (model) log.info("model", `reset config to defaults for ${model}`);
    // Re-derive the projector now that mmproj is back to "" and unpinned.
    get().autoDetectMmproj();
  },

  setMmproj: (path) => {
    const { flags, settings } = get();
    const model = flags.model as string | undefined;
    const next = { ...flags, mmproj: path };
    set({ flags: next });
    let updated = applyPerModel(settings, next);
    if (model && !(updated.mmproj_pinned ?? []).includes(model)) {
      updated = { ...updated, mmproj_pinned: [...(updated.mmproj_pinned ?? []), model] };
    }
    get().setSettings(updated);
    persistSettings(updated);
    if (model) log.info("model", `pinned --mmproj for ${model}: ${path || "(none)"}`);
  },

  unpinMmproj: () => {
    const { flags, settings } = get();
    const model = flags.model as string | undefined;
    if (!model) return;
    const updated: Settings = {
      ...settings,
      mmproj_pinned: (settings.mmproj_pinned ?? []).filter((m) => m !== model),
    };
    get().setSettings(updated);
    persistSettings(updated);
    log.info("model", `mmproj back to auto for ${model}`);
    get().autoDetectMmproj();
  },

  autoDetectMmproj: () => {
    const { flags, settings, modelInfo } = get();
    const model = flags.model as string | undefined;
    if (!model || !modelInfo) return;
    if ((settings.mmproj_pinned ?? []).includes(model)) return; // user owns it
    const decision = resolveMmproj((flags.mmproj as string) || "", modelInfo.mmproj_siblings);
    if (decision.type === "set") {
      log.info("model", `auto-set --mmproj: ${decision.value}`);
      get().setFlag("mmproj", decision.value);
    } else if (decision.type === "clear") {
      log.info("model", "clearing --mmproj (no sibling in model dir)");
      get().setFlag("mmproj", "");
    }
  },
});
