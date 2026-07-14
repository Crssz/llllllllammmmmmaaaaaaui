import type { IconName } from "./icons";

export const MODEL = {
  id: "Qwen3.6-27B-Q8_0-mtp.gguf",
  display: "Qwen3.6-27B",
  quant: "Q8_0",
  size_gb: 27.6,
  ctx_max: 131072,
  has_mtp: true,
};

export type Profile = {
  id: string;
  name: string;
  model: string;
  quant: string;
  tags: string[];
  summary: string;
  lastRun: string;
  active: boolean;
  settings: {
    ctx: number;
    ngl: number;
    fa: boolean;
    ctk: string;
    ctv: string;
    batch: number;
  };
};

export const PROFILES: Profile[] = [
  {
    id: "mtp-qwen",
    name: "Qwen 3.6 MTP",
    model: "Qwen3.6-27B",
    quant: "Q8_0",
    tags: ["MTP", "32k ctx", "2.4× speedup"],
    summary: "MTP heads embedded in the GGUF. n-max 3, ~72% accept. All layers on GPU.",
    lastRun: "now",
    active: true,
    settings: { ctx: 32768, ngl: 999, fa: true, ctk: "q8_0", ctv: "q8_0", batch: 2048 },
  },
  {
    id: "long-ctx",
    name: "Long context coder",
    model: "openai/gpt-oss-20b",
    quant: "Q5_K_M",
    tags: ["coding", "128k ctx", "GPU heavy"],
    summary: "All layers on GPU. Flash attention on. Q8 KV cache to fit 128k.",
    lastRun: "2h ago",
    active: false,
    settings: { ctx: 131072, ngl: 999, fa: true, ctk: "q8_0", ctv: "q8_0", batch: 2048 },
  },
  {
    id: "speedy-chat",
    name: "Speedy chat",
    model: "llama-3.1-8b",
    quant: "Q4_K_M",
    tags: ["chat", "8k ctx", "low VRAM"],
    summary: "Small ctx, F16 KV, max throughput on a single GPU.",
    lastRun: "yesterday",
    active: false,
    settings: { ctx: 8192, ngl: 33, fa: true, ctk: "f16", ctv: "f16", batch: 512 },
  },
  {
    id: "cpu-only",
    name: "CPU-only laptop",
    model: "qwen2.5-7b",
    quant: "Q4_K_M",
    tags: ["mobile", "CPU", "16 threads"],
    summary: "Zero GPU offload, mmap on, mlock off. Battery-aware threading.",
    lastRun: "3d ago",
    active: false,
    settings: { ctx: 4096, ngl: 0, fa: false, ctk: "f16", ctv: "f16", batch: 256 },
  },
  {
    id: "moe-balanced",
    name: "MoE balanced",
    model: "mixtral-8x7b",
    quant: "Q4_K_M",
    tags: ["MoE", "experts: 2/8", "partial GPU"],
    summary: "Force first 8 MoE layers to CPU. Activates 2 experts per token.",
    lastRun: "1w ago",
    active: false,
    settings: { ctx: 32768, ngl: 24, fa: true, ctk: "q8_0", ctv: "q8_0", batch: 1024 },
  },
];

export type Conversation = {
  id: string;
  title: string;
  tokens: number;
  pinned: boolean;
  recent: boolean;
};

export const CONVERSATIONS: Conversation[] = [
  { id: "fs-cpp", title: "Toy filesystem in C++", tokens: 783, pinned: true, recent: true },
  { id: "rope", title: "Tune RoPE for long ctx", tokens: 4120, pinned: false, recent: true },
  { id: "fa-bench", title: "Flash attention benchmark", tokens: 219, pinned: false, recent: true },
  { id: "moe", title: "MoE expert routing notes", tokens: 1502, pinned: false, recent: false },
];

export const HARDWARE = {
  gpus: [
    {
      id: 0,
      name: "RTX 4090",
      vram_total: 24,
      vram_used: 16.8,
      util: 78,
      temp: 64,
      power: 312,
      clock: 2520,
    },
    {
      id: 1,
      name: "RTX 4090",
      vram_total: 24,
      vram_used: 8.1,
      util: 42,
      temp: 56,
      power: 184,
      clock: 2380,
    },
  ],
  cpu: { name: "Threadripper PRO 5975WX", cores: 32, threads: 64, util: 18, temp: 48, freq: 3.6 },
  ram: { total: 128, used: 41.2, swap_used: 0 },
  power_w: 521,
  uptime: "00:24:13",
};

export const SPARKS = {
  vram: [12, 13, 14, 14.5, 15, 15.2, 16, 16.4, 16.8, 16.7, 16.8],
  gpu: [60, 70, 75, 82, 78, 80, 85, 79, 76, 78, 78],
  cpu: [12, 15, 18, 14, 16, 18, 22, 19, 17, 18, 18],
  tps: [12, 14, 16, 15, 18, 19, 20, 18, 19, 18, 18.7],
};

export type FlagType = "slider" | "toggle" | "select" | "text" | "path";

export type FlagDef = {
  key: string;
  label: string;
  desc: string;
  flag: string;
  type: FlagType;
  value: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  only?: string;
  // For sliders that accept a sentinel value outside the normal range
  // (e.g. llama.cpp's -ngl 999 = "all layers"). When the flag's value equals
  // `maxAlias.value`, a labeled checkbox is rendered and the slider is locked
  // at its max. Unchecking restores `max`.
  maxAlias?: { value: number; label: string };
};

export type FlagGroup = {
  id: string;
  label: string;
  icon: IconName;
  defaultOpen: boolean;
  flags: FlagDef[];
};

export const FLAG_GROUPS: FlagGroup[] = [
  {
    id: "model",
    label: "Model",
    icon: "Folder",
    defaultOpen: true,
    flags: [
      {
        key: "model",
        label: "Model file",
        desc: "GGUF weights to load",
        flag: "--model",
        type: "path",
        value: "",
      },
      {
        key: "alias",
        label: "Alias",
        desc: "Name reported by API",
        flag: "--alias",
        type: "text",
        value: "",
      },
      {
        key: "lora",
        label: "LoRA adapter",
        desc: "Optional fine-tune overlay",
        flag: "--lora",
        type: "path",
        value: "",
      },
      {
        key: "mmproj",
        label: "Multi-modal projector",
        desc: "mmproj-*.gguf for vision models (auto-detected when next to the model file)",
        flag: "-mmp, --mmproj",
        type: "path",
        value: "",
      },
    ],
  },
  {
    id: "context",
    label: "Context & batching",
    icon: "Brain",
    defaultOpen: true,
    flags: [
      {
        key: "ctx",
        label: "Context length",
        desc: "Tokens of working memory",
        flag: "-c, --ctx-size",
        type: "slider",
        value: 32768,
        min: 2048,
        max: 131072,
        step: 1024,
      },
      {
        key: "batch",
        label: "Batch size",
        desc: "Tokens evaluated together",
        flag: "-b, --batch-size",
        type: "slider",
        value: 2048,
        min: 64,
        max: 8192,
        step: 64,
      },
      {
        key: "ubatch",
        label: "Micro-batch",
        desc: "Inner-loop sub-batch",
        flag: "-ub, --ubatch-size",
        type: "slider",
        value: 512,
        min: 32,
        max: 2048,
        step: 32,
      },
      {
        key: "parallel",
        label: "Parallel slots",
        desc: "Simultaneous sequences",
        flag: "-np, --parallel",
        type: "slider",
        value: 1,
        min: 1,
        max: 8,
        step: 1,
      },
    ],
  },
  {
    id: "hw",
    label: "Hardware & threads",
    icon: "Cpu",
    defaultOpen: true,
    flags: [
      {
        key: "ngl",
        label: "GPU layers",
        desc: "Layers offloaded to GPU. Tick the box to offload all.",
        flag: "-ngl, --n-gpu-layers",
        type: "slider",
        value: 30,
        min: 0,
        max: 100,
        step: 1,
        maxAlias: { value: 999, label: "All layers" },
      },
      {
        key: "threads",
        label: "CPU threads",
        desc: "Generation threads",
        flag: "-t, --threads",
        type: "slider",
        value: 12,
        min: 1,
        max: 64,
        step: 1,
      },
      {
        key: "tb",
        label: "Batch threads",
        desc: "Prompt-eval threads",
        flag: "-tb, --threads-batch",
        type: "slider",
        value: 16,
        min: 1,
        max: 64,
        step: 1,
      },
      {
        key: "split",
        label: "Split mode",
        desc: "How to split across GPUs",
        flag: "--split-mode",
        type: "select",
        value: "layer",
        options: ["none", "layer", "row"],
      },
      {
        key: "main_gpu",
        label: "Main GPU",
        desc: "Device index for KV cache",
        flag: "-mg, --main-gpu",
        type: "select",
        value: "0",
        options: ["0", "1"],
      },
    ],
  },
  {
    id: "memory",
    label: "Memory & attention",
    icon: "Mem",
    defaultOpen: false,
    flags: [
      {
        key: "fa",
        label: "Flash attention",
        desc: "Fused attention kernel",
        flag: "-fa, --flash-attn",
        type: "toggle",
        value: true,
      },
      {
        key: "mmap",
        label: "Memory map",
        desc: "Memory-map the model file (default on)",
        flag: "--no-mmap",
        type: "toggle",
        value: true,
      },
      {
        key: "mlock",
        label: "Lock in RAM",
        desc: "Prevent swap-out",
        flag: "--mlock",
        type: "toggle",
        value: false,
      },
      {
        key: "ctk",
        label: "K cache dtype",
        desc: "Quant for keys",
        flag: "-ctk, --cache-type-k",
        type: "select",
        value: "q8_0",
        options: ["f32", "f16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0"],
      },
      {
        key: "ctv",
        label: "V cache dtype",
        desc: "Quant for values",
        flag: "-ctv, --cache-type-v",
        type: "select",
        value: "q8_0",
        options: ["f32", "f16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0"],
      },
      {
        key: "nkvo",
        label: "Keep KV on CPU",
        desc: "Don't offload KV cache",
        flag: "-nkvo, --no-kv-offload",
        type: "toggle",
        value: false,
      },
    ],
  },
  {
    id: "spec",
    label: "Speculative decoding",
    icon: "Bolt",
    defaultOpen: false,
    flags: [
      {
        key: "spec_type",
        label: "Speculator type",
        desc: "none · draft-simple (separate draft GGUF) · draft-mtp (MTP heads in model GGUF or explicit drafter) · draft-eagle3 · draft-dflash (block-diffusion drafter GGUF)",
        flag: "--spec-type",
        type: "select",
        value: "none",
        options: ["none", "draft-simple", "draft-mtp", "draft-eagle3", "draft-dflash"],
      },
      {
        key: "model_draft_mtp",
        label: "MTP drafter",
        desc: "Optional GGUF holding the MTP heads. Leave empty when the model GGUF already contains them.",
        flag: "-md, --model-draft",
        type: "path",
        value: "",
        only: "draft-mtp",
      },
      {
        key: "spec_n_max",
        label: "Draft tokens (max)",
        desc: "Max tokens drafted by MTP heads per step",
        flag: "--spec-draft-n-max",
        type: "slider",
        value: 3,
        min: 1,
        max: 8,
        step: 1,
        only: "draft-mtp",
      },
      {
        key: "spec_n_min",
        label: "Draft tokens (min)",
        desc: "Min tokens drafted before verify",
        flag: "--spec-draft-n-min",
        type: "slider",
        value: 1,
        min: 0,
        max: 4,
        step: 1,
        only: "draft-mtp",
      },
      {
        key: "model_draft",
        label: "Draft model",
        desc: "Smaller GGUF used as the speculator",
        flag: "-md, --model-draft",
        type: "path",
        value: "",
        only: "draft-simple",
      },
      {
        key: "ngld",
        label: "Draft GPU layers",
        desc: "Layers of draft model on GPU",
        flag: "-ngld, --n-gpu-layers-draft",
        type: "slider",
        value: 33,
        min: 0,
        max: 33,
        step: 1,
        only: "draft-simple",
      },
      {
        key: "ctx_draft",
        label: "Draft context",
        desc: "Working context for the draft model",
        flag: "-cd, --ctx-size-draft",
        type: "slider",
        value: 8192,
        min: 1024,
        max: 32768,
        step: 1024,
        only: "draft-simple",
      },
      {
        key: "draft_max",
        label: "Draft tokens (max)",
        desc: "Most tokens drafted per step",
        flag: "--draft-max",
        type: "slider",
        value: 16,
        min: 1,
        max: 32,
        step: 1,
        only: "draft-simple",
      },
      {
        key: "draft_min",
        label: "Draft tokens (min)",
        desc: "Minimum drafted before verify",
        flag: "--draft-min",
        type: "slider",
        value: 5,
        min: 0,
        max: 16,
        step: 1,
        only: "draft-simple",
      },
      {
        key: "draft_p_min",
        label: "Accept threshold",
        desc: "Min probability to accept a drafted token",
        flag: "--draft-p-min",
        type: "slider",
        value: 0.9,
        min: 0,
        max: 1,
        step: 0.05,
        only: "draft-simple",
      },
      {
        key: "device_draft",
        label: "Draft device",
        desc: "GPU used for the draft model",
        flag: "-devd, --device-draft",
        type: "select",
        value: "GPU1",
        options: ["CPU", "GPU0", "GPU1", "auto"],
        only: "draft-simple",
      },
      {
        key: "model_draft_dflash",
        label: "DFlash drafter",
        desc: "Block-diffusion DFlash draft GGUF (e.g. Qwen3-DFlash.gguf). Required — DFlash always needs a separate trained drafter. Needs a llama.cpp build with the DFlash patch (PR #22105).",
        flag: "-md, --model-draft",
        type: "path",
        value: "",
        only: "draft-dflash",
      },
      {
        key: "spec_dflash_n_max",
        label: "Draft block (max)",
        desc: "Max tokens drafted per step. Clamped to the drafter's trained block size (GGUF default 16).",
        flag: "--spec-draft-n-max",
        type: "slider",
        value: 16,
        min: 1,
        max: 32,
        step: 1,
        only: "draft-dflash",
      },
      {
        key: "spec_dflash_n_min",
        label: "Draft block (min)",
        desc: "Min tokens drafted before verify (0 = let the drafter decide)",
        flag: "--spec-draft-n-min",
        type: "slider",
        value: 0,
        min: 0,
        max: 16,
        step: 1,
        only: "draft-dflash",
      },
      {
        key: "ngld_dflash",
        label: "Draft GPU layers",
        desc: "Layers of the DFlash drafter on GPU. The drafter is tiny — offload all (99).",
        flag: "-ngld, --n-gpu-layers-draft",
        type: "slider",
        value: 99,
        min: 0,
        max: 99,
        step: 1,
        only: "draft-dflash",
      },
      {
        key: "ctx_draft_dflash",
        label: "Draft context",
        desc: "Working context for the drafter. DFlash drafts short blocks, so a small context suffices.",
        flag: "-cd, --ctx-size-draft",
        type: "slider",
        value: 256,
        min: 256,
        max: 8192,
        step: 256,
        only: "draft-dflash",
      },
    ],
  },
  {
    id: "templates",
    label: "Chat templates",
    icon: "Chat",
    defaultOpen: false,
    flags: [
      {
        key: "jinja",
        label: "Use Jinja template",
        desc: "Enable the GGUF's embedded Jinja chat template (recommended)",
        flag: "--jinja",
        type: "toggle",
        value: true,
      },
      {
        key: "chat_template",
        label: "Built-in template",
        desc: "Override with a built-in template (e.g. chatml, llama2, llama3, mistral). Leave empty to use the GGUF default.",
        flag: "--chat-template",
        type: "text",
        value: "",
      },
      {
        key: "chat_template_file",
        label: "Custom template file",
        desc: "Path to a .jinja file. Takes precedence over --chat-template.",
        flag: "--chat-template-file",
        type: "path",
        value: "",
      },
      {
        key: "reasoning_format",
        label: "Reasoning format",
        desc: "How to surface <think> blocks from reasoning models",
        flag: "--reasoning-format",
        type: "select",
        value: "auto",
        options: ["auto", "none", "deepseek", "deepseek-legacy"],
      },
    ],
  },
  {
    id: "rope",
    label: "RoPE scaling",
    icon: "Spark",
    defaultOpen: false,
    flags: [
      {
        key: "rope_scaling",
        label: "Scaling type",
        desc: "Method for extending ctx",
        flag: "--rope-scaling",
        type: "select",
        value: "none",
        options: ["none", "linear", "yarn"],
      },
      {
        key: "rope_base",
        label: "Freq base",
        desc: "RoPE θ base (auto = model default)",
        flag: "--rope-freq-base",
        type: "text",
        value: "auto",
      },
      {
        key: "rope_scale",
        label: "Freq scale",
        desc: "Linear scale factor",
        flag: "--rope-freq-scale",
        type: "text",
        value: "auto",
      },
    ],
  },
  {
    id: "server",
    label: "Server",
    icon: "Globe",
    defaultOpen: false,
    flags: [
      {
        key: "host",
        label: "Host",
        desc: "Bind address",
        flag: "--host",
        type: "text",
        value: "127.0.0.1",
      },
      {
        key: "port",
        label: "Port",
        desc: "HTTP port",
        flag: "--port",
        type: "text",
        value: "8080",
      },
      {
        key: "api_key",
        label: "API key",
        desc: "Optional auth",
        flag: "--api-key",
        type: "text",
        value: "",
      },
      {
        key: "slots",
        label: "Slot save path",
        desc: "Persist KV slots between requests",
        flag: "--slot-save-path",
        type: "text",
        value: "",
      },
    ],
  },
];

// Flatten the FLAG_GROUPS defaults into a single flag-values record. Used to
// seed the store on first run (main.tsx) and to reset a model's config back to
// defaults (the per-model "reset" escape hatch).
export function defaultFlags(): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const g of FLAG_GROUPS) {
    for (const f of g.flags) {
      out[f.key] = f.value;
    }
  }
  return out;
}

// ── hipfire engine flags ────────────────────────────────────────────────────
// hipfire is a source-built Vulkan/HIP inference engine with an OpenAI-
// compatible server, driven from a pre-registered model TAG rather than a raw
// .gguf (see hipfireConvert / buildHipfireArgs). These groups reuse the same
// FlagRow renderer as FLAG_GROUPS, but their values live in
// `settings.hipfire_flags` (written via setHipfireFlag) and are consumed by
// buildHipfireArgs. Group ids are prefixed "hipfire-" so they never collide
// with the llama FLAG_GROUPS ids in the Configure collapse-state map.
export const HIPFIRE_FLAG_GROUPS: FlagGroup[] = [
  {
    id: "hipfire-server",
    label: "Server",
    icon: "Globe",
    defaultOpen: true,
    flags: [
      {
        key: "tag",
        label: "Model tag",
        desc: "Tag registered by `hipfire quantize --install --register <tag>` — see the conversion panel above",
        flag: "serve <tag>",
        type: "text",
        value: "",
      },
      {
        key: "host",
        label: "Host",
        desc: "Bind address, sent positionally as host:port",
        flag: "<host>:port",
        type: "text",
        value: "127.0.0.1",
      },
      {
        key: "port",
        label: "Port",
        desc: "HTTP port for the OpenAI-compatible server, sent positionally as host:port",
        flag: "host:<port>",
        type: "text",
        value: "8080",
      },
      {
        key: "idle_timeout",
        label: "Idle timeout (s)",
        desc: "Unload the model after this many idle seconds. Leave empty to use hipfire's default.",
        flag: "--idle-timeout",
        type: "text",
        value: "",
      },
    ],
  },
  {
    id: "hipfire-hw",
    label: "Hardware",
    icon: "Cpu",
    defaultOpen: true,
    flags: [
      {
        // VERIFIED (live `hipfire config list`): accepted --kv-mode values
        // are auto|q8|asym4|asym3|asym2|fwht4|fwht3|fwht2|turbo. (TODO
        // resolved — this replaces the earlier unverified f16/q8/q4 guess.)
        key: "kv_mode",
        label: "KV cache mode",
        desc: "KV cache quantization mode. Empty/unset uses hipfire's default.",
        flag: "--kv-mode",
        type: "select",
        value: "",
        options: [
          "",
          "auto",
          "q8",
          "asym4",
          "asym3",
          "asym2",
          "fwht4",
          "fwht3",
          "fwht2",
          "turbo",
        ],
      },
      {
        key: "tp",
        label: "Tensor parallel degree",
        desc: "Number of GPUs to split the model across. Leave empty for single-GPU.",
        flag: "--tp",
        type: "text",
        value: "",
      },
    ],
  },
  // A "Speculative decoding" flag group previously lived here (spec /
  // model_draft / draft_max, emitted as --spec/-md/--draft-max). REMOVED:
  // live verification (`hipfire serve --help`) confirmed those are
  // `hipfire run`-only flags — `serve` rejects them and fails to start. The
  // serve daemon controls speculation entirely through config keys instead
  // (`hipfire config list`: speculation=auto, dflash_mode=auto, mtp_mode,
  // ngram_mode, ...) and engages DFlash automatically when a draft model is
  // present (confirmed live: a streamed completion returned
  // timings:{...,"dflash":true} with no serve flags at all). Per-daemon
  // speculation control, if ever wanted, must be done via
  // `hipfire config set speculation|dflash_mode ...` BEFORE serving — a
  // future enhancement, not a UI flag group here. See buildHipfireArgs.ts.
];

// Flatten the HIPFIRE_FLAG_GROUPS defaults into a single flag-values record,
// mirroring defaultFlags(). buildHipfireArgs applies its own host/port
// fallbacks, so an empty hipfire_flags bag is also valid; this is the
// fully-populated baseline.
export function defaultHipfireFlags(): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const g of HIPFIRE_FLAG_GROUPS) {
    for (const f of g.flags) {
      out[f.key] = f.value;
    }
  }
  return out;
}

export type BuildBinary = {
  name: string;
  size: string;
  ok: boolean;
  primary: boolean;
  desc: string;
};

export const BUILD = {
  path: "/Users/marc/code/llama.cpp/build/bin",
  version: "b6841",
  commit: "10829dbc",
  date: "May 4, 2026",
  backend: "CUDA 12.4",
  backendBadges: ["CUDA 12.4", "cuBLAS", "Flash-Attn"],
  detected: true,
  binaries: [
    { name: "llama-server", size: "42 MB", ok: true, primary: true, desc: "HTTP/WebSocket server" },
    { name: "llama-cli", size: "38 MB", ok: true, primary: false, desc: "Interactive REPL" },
    { name: "llama-bench", size: "39 MB", ok: true, primary: false, desc: "Throughput benchmark" },
    {
      name: "llama-quantize",
      size: "12 MB",
      ok: true,
      primary: false,
      desc: "Convert / quantize GGUFs",
    },
    { name: "llama-perplexity", size: "37 MB", ok: true, primary: false, desc: "Eval perplexity" },
    {
      name: "llama-embedding",
      size: "36 MB",
      ok: false,
      primary: false,
      desc: "Not built — run `cmake --build . --target llama-embedding`",
    },
  ] satisfies BuildBinary[],
  recent: [
    "/Users/marc/code/llama.cpp/build/bin",
    "/opt/llama.cpp/build/bin",
    "/Users/marc/code/llama.cpp/build-cpu/bin",
  ],
};

// ── Models library ─────────────────────────────────────────────────────────
export type Quant = {
  tag: string;
  sizeGB: number;
  bits: 3 | 4 | 5 | 6 | 8 | 16;
  active?: boolean;
  badges?: string[];
};

export type ModelEntry = {
  name: string;
  params: string;
  family: string;
  mtp?: boolean;
  draft?: boolean;
  quants: Quant[];
};

export type OwnerEntry = {
  owner: string;
  models: ModelEntry[];
};

export const MODELS_DIR = {
  path: "/Users/marc/.cache/lm-models",
  totalGB: 312.4,
  count: 14,
  owners: 5,
  recent: [
    "/Users/marc/.cache/lm-models",
    "/Users/marc/.cache/huggingface/hub",
    "/mnt/nvme/models",
  ],
};

export const MODELS_TREE: OwnerEntry[] = [
  {
    owner: "Qwen",
    models: [
      {
        name: "Qwen3.6-27B",
        params: "27B",
        family: "Dense",
        mtp: true,
        quants: [
          { tag: "Q4_K_M", sizeGB: 16.2, bits: 4 },
          { tag: "Q5_K_M", sizeGB: 19.4, bits: 5 },
          { tag: "Q8_0-mtp", sizeGB: 27.6, bits: 8, active: true, badges: ["MTP"] },
        ],
      },
      {
        name: "Qwen2.5-7B-Instruct",
        params: "7B",
        family: "Dense",
        quants: [
          { tag: "Q4_K_M", sizeGB: 4.4, bits: 4 },
          { tag: "Q5_K_M", sizeGB: 5.1, bits: 5 },
          { tag: "Q8_0", sizeGB: 7.6, bits: 8 },
        ],
      },
    ],
  },
  {
    owner: "openai",
    models: [
      {
        name: "gpt-oss-20b",
        params: "20B",
        family: "MoE",
        quants: [
          { tag: "Q4_K_M", sizeGB: 10.2, bits: 4 },
          { tag: "Q5_K_M", sizeGB: 14.2, bits: 5 },
          { tag: "Q8_0", sizeGB: 22.1, bits: 8 },
        ],
      },
    ],
  },
  {
    owner: "meta-llama",
    models: [
      {
        name: "Llama-3.1-8B-Instruct",
        params: "8B",
        family: "Dense",
        quants: [
          { tag: "Q4_K_M", sizeGB: 4.9, bits: 4 },
          { tag: "Q5_K_M", sizeGB: 5.8, bits: 5 },
          { tag: "Q8_0", sizeGB: 8.5, bits: 8 },
          { tag: "F16", sizeGB: 16.1, bits: 16 },
        ],
      },
      {
        name: "Llama-3.2-1B-Instruct",
        params: "1B",
        family: "Dense",
        draft: true,
        quants: [
          { tag: "Q4_K_M", sizeGB: 0.8, bits: 4 },
          { tag: "Q8_0", sizeGB: 1.3, bits: 8 },
        ],
      },
    ],
  },
  {
    owner: "mistralai",
    models: [
      {
        name: "Mixtral-8x7B-Instruct-v0.1",
        params: "8×7B",
        family: "MoE",
        quants: [
          { tag: "Q3_K_M", sizeGB: 20.4, bits: 3 },
          { tag: "Q4_K_M", sizeGB: 26.4, bits: 4 },
        ],
      },
    ],
  },
  {
    owner: "deepseek-ai",
    models: [
      {
        name: "DeepSeek-V3.1-Lite",
        params: "16B",
        family: "MoE",
        mtp: true,
        quants: [
          { tag: "Q4_K_M-mtp", sizeGB: 9.2, bits: 4, badges: ["MTP"] },
          { tag: "Q8_0-mtp", sizeGB: 17.4, bits: 8, badges: ["MTP"] },
        ],
      },
      {
        name: "DeepSeek-Coder-V2-Lite",
        params: "16B",
        family: "MoE",
        quants: [
          { tag: "Q4_K_M", sizeGB: 9.4, bits: 4 },
          { tag: "Q6_K", sizeGB: 13.1, bits: 6 },
        ],
      },
    ],
  },
];
