// Build the `llama-mtmd-cli` argv for a one-shot audio→text transcription.
// Mirrors buildArgs.ts: returns flat strings ready for the Rust side to hand to
// std::process::Command's args() — no binary prefix, no shell quoting (each
// element is a discrete argv entry, so a prompt with spaces stays one token).
//
// The model + projector + audio + prompt quartet is always emitted: the CLI
// drops into interactive chat mode when a prompt or media is missing, so the
// caller must supply all four (the screen enforces this before invoking).

export type MtmdOpts = {
  model: string;
  mmproj: string;
  audio: string;
  prompt: string;
  /** GPU layers to offload (-ngl). Pass null to let the CLI auto-pick. */
  ngl?: number | null;
  threads?: number | null;
  ctx?: number | null;
  temp?: number | null;
  /** Cap on generated tokens (-n). Null / <=0 → unbounded (CLI default). */
  nPredict?: number | null;
};

export function buildMtmdArgs(o: MtmdOpts): string[] {
  const out: string[] = [];
  const push = (flag: string, val: string | number) => {
    out.push(flag, String(val));
  };

  push("--model", o.model);
  push("--mmproj", o.mmproj);
  push("--audio", o.audio);
  push("--prompt", o.prompt);

  // --n-gpu-layers accepts 0 (CPU only), so only an explicit null is omitted.
  if (o.ngl !== null && o.ngl !== undefined) push("--n-gpu-layers", o.ngl);
  if (o.threads !== null && o.threads !== undefined && o.threads > 0) push("--threads", o.threads);
  if (o.ctx !== null && o.ctx !== undefined && o.ctx > 0) push("--ctx-size", o.ctx);
  if (o.temp !== null && o.temp !== undefined && o.temp >= 0) push("--temp", o.temp);
  if (o.nPredict !== null && o.nPredict !== undefined && o.nPredict > 0)
    push("--n-predict", o.nPredict);

  return out;
}
