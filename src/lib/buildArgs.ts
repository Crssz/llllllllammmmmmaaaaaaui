export type FlagValue = string | number | boolean;
export type Values = Record<string, FlagValue>;

// Build the llama-server argv list (no "llama-server" prefix, no line-break "\").
// Returns flat strings ready for std::process::Command's args().
export function buildArgs(vals: Values): string[] {
  const out: string[] = [];
  const push = (flag: string, val?: string | number | boolean | null) => {
    out.push(flag);
    if (val !== null && val !== undefined && val !== "") {
      out.push(String(val));
    }
  };
  const M = (k: string) => vals[k];
  const truthy = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== false;

  if (truthy(M("model"))) push("--model", M("model") as string);
  if (truthy(M("alias"))) push("--alias", M("alias") as string);
  if (truthy(M("lora"))) push("--lora", M("lora") as string);
  if (truthy(M("mmproj"))) push("--mmproj", M("mmproj") as string);
  push("--ctx-size", M("ctx") as number);
  push("--batch-size", M("batch") as number);
  push("--ubatch-size", M("ubatch") as number);
  if ((M("parallel") as number) > 1) push("--parallel", M("parallel") as number);
  push("--n-gpu-layers", M("ngl") as number);
  push("--threads", M("threads") as number);
  push("--threads-batch", M("tb") as number);
  if (M("split") !== "layer") push("--split-mode", M("split") as string);
  if (M("main_gpu") !== "0") push("--main-gpu", M("main_gpu") as string);
  // Newer llama-server requires --flash-attn to take an explicit value
  // ('on' | 'off' | 'auto'). Emitting it bare swallows the next token.
  push("--flash-attn", M("fa") ? "on" : "off");
  if (!M("mmap")) out.push("--no-mmap");
  if (M("mlock")) out.push("--mlock");
  push("--cache-type-k", M("ctk") as string);
  push("--cache-type-v", M("ctv") as string);
  if (M("nkvo")) out.push("--no-kv-offload");
  const specType = M("spec_type") as string;
  if (specType === "draft-mtp") {
    push("--spec-type", "draft-mtp");
    // MTP heads usually live in the model GGUF; an explicit drafter GGUF is optional.
    if (truthy(M("model_draft_mtp"))) push("--model-draft", M("model_draft_mtp") as string);
    push("--spec-draft-n-max", M("spec_n_max") as number);
    if ((M("spec_n_min") as number) > 0) push("--spec-draft-n-min", M("spec_n_min") as number);
  } else if (specType === "draft-simple" && truthy(M("model_draft"))) {
    push("--spec-type", "draft-simple");
    push("--model-draft", M("model_draft") as string);
    push("--n-gpu-layers-draft", M("ngld") as number);
    push("--ctx-size-draft", M("ctx_draft") as number);
    push("--draft-max", M("draft_max") as number);
    push("--draft-min", M("draft_min") as number);
    push("--draft-p-min", M("draft_p_min") as number);
    if (M("device_draft") !== "auto") push("--device-draft", M("device_draft") as string);
  } else if (specType === "draft-eagle3") {
    push("--spec-type", "draft-eagle3");
  }
  // "none" or anything else: emit nothing so llama-server uses its default.
  // Templates
  if (M("jinja")) out.push("--jinja");
  if (truthy(M("chat_template"))) push("--chat-template", M("chat_template") as string);
  if (truthy(M("chat_template_file")))
    push("--chat-template-file", M("chat_template_file") as string);
  if (truthy(M("reasoning_format")) && M("reasoning_format") !== "auto")
    push("--reasoning-format", M("reasoning_format") as string);

  if (M("rope_scaling") !== "none") push("--rope-scaling", M("rope_scaling") as string);
  if (truthy(M("rope_base")) && M("rope_base") !== "auto")
    push("--rope-freq-base", M("rope_base") as string);
  if (truthy(M("rope_scale")) && M("rope_scale") !== "auto")
    push("--rope-freq-scale", M("rope_scale") as string);
  push("--host", M("host") as string);
  push("--port", M("port") as string);
  if (truthy(M("api_key"))) push("--api-key", M("api_key") as string);
  if (truthy(M("slots"))) push("--slot-save-path", M("slots") as string);
  return out;
}
