import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore, freshStore, stubApi } from "../testUtils";
import { api } from "../../lib/api";

function readyServer() {
  useAppStore.setState({
    server: {
      running: true,
      ready: true,
      info: { pid: 1, port: 8080, started_at: 0, binary: "llama-server" },
    },
  });
}

/** A fetch-Response stand-in whose body streams the given SSE lines. */
function fakeRes(lines: string[], opts: { ok?: boolean; status?: number; errText?: string } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    body,
    text: async () => opts.errText ?? "",
  };
}

describe("transcribeSlice", () => {
  beforeEach(() => {
    freshStore();
    stubApi();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to start when the server isn't ready", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await useAppStore.getState().startTranscribe({ audioPath: "/a.wav", prompt: "go" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().trError).toMatch(/Start llama-server/);
  });

  it("streams transcript text from the server into trOutput", async () => {
    readyServer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeRes([
          'data: {"choices":[{"delta":{"content":"Hello "}}]}\n',
          'data: {"choices":[{"delta":{"content":"world"}}]}\n',
          "data: [DONE]\n",
        ]),
      ),
    );
    await useAppStore.getState().startTranscribe({ audioPath: "/a.wav", prompt: "transcribe" });
    const s = useAppStore.getState();
    expect(s.trOutput).toBe("Hello world");
    expect(s.trRunning).toBe(false);
    expect(s.trError).toBeNull();
    expect(api.readAudioBase64).toHaveBeenCalledWith("/a.wav");
  });

  it("posts an input_audio content part plus sampling params", async () => {
    readyServer();
    vi.mocked(api.readAudioBase64).mockResolvedValueOnce({ data: "BASE64", format: "mp3" });
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => fakeRes(["data: [DONE]\n"]));
    vi.stubGlobal("fetch", fetchSpy);
    await useAppStore.getState().startTranscribe({
      audioPath: "/a.mp3",
      prompt: "say what",
      temperature: 0.3,
      maxTokens: 128,
    });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "say what" },
      { type: "input_audio", input_audio: { data: "BASE64", format: "mp3" } },
    ]);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(128);
  });

  it("surfaces an HTTP error when nothing was produced", async () => {
    readyServer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeRes([], { ok: false, status: 500, errText: "boom" })),
    );
    await useAppStore.getState().startTranscribe({ audioPath: "/a.wav", prompt: "x" });
    const s = useAppStore.getState();
    expect(s.trRunning).toBe(false);
    expect(s.trError).toMatch(/HTTP 500/);
  });

  it("surfaces a read-audio failure without calling fetch", async () => {
    readyServer();
    vi.mocked(api.readAudioBase64).mockRejectedValueOnce(new Error("not wav/mp3"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await useAppStore.getState().startTranscribe({ audioPath: "/a.flac", prompt: "x" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().trError).toBe("not wav/mp3");
    expect(useAppStore.getState().trRunning).toBe(false);
  });

  it("cancelTranscribe aborts the in-flight request and stops running", () => {
    const ac = new AbortController();
    const abortSpy = vi.spyOn(ac, "abort");
    useAppStore.setState({ trRunning: true, _trAbort: ac });
    useAppStore.getState().cancelTranscribe();
    expect(abortSpy).toHaveBeenCalled();
    const s = useAppStore.getState();
    expect(s.trRunning).toBe(false);
    expect(s._trAbort).toBeNull();
  });

  it("clearTranscribe resets output and error", () => {
    useAppStore.setState({ trOutput: "old", trError: "e", trRunning: false });
    useAppStore.getState().clearTranscribe();
    const s = useAppStore.getState();
    expect(s.trOutput).toBe("");
    expect(s.trError).toBeNull();
  });

  it("refuses to start when no server is up and the engine toggle is set to hipfire", async () => {
    useAppStore.getState().setSettings({
      ...useAppStore.getState().settings,
      engine_kind: "hipfire",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await useAppStore.getState().startTranscribe({ audioPath: "/a.wav", prompt: "go" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().trError).toMatch(/llama\.cpp engine/i);
  });

  it("stays available on a live llama-server even after the toggle flips to hipfire", async () => {
    // loadedEngine (what's RUNNING) is llama; the toggle alone must not block.
    readyServer();
    useAppStore.setState({ loadedEngine: "llama" });
    useAppStore.getState().setSettings({
      ...useAppStore.getState().settings,
      engine_kind: "hipfire",
    });
    vi.stubGlobal("fetch", vi.fn(async () => fakeRes(["data: [DONE]\n"])));
    await useAppStore.getState().startTranscribe({ audioPath: "/a.wav", prompt: "go" });
    expect(useAppStore.getState().trError).toBeNull();
  });

  it("blocks a live hipfire server even if the toggle now reads llama", async () => {
    readyServer();
    useAppStore.setState({ loadedEngine: "hipfire" });
    useAppStore.getState().setSettings({
      ...useAppStore.getState().settings,
      engine_kind: "llama",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await useAppStore.getState().startTranscribe({ audioPath: "/a.wav", prompt: "go" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().trError).toMatch(/llama\.cpp engine/i);
  });

  it("BUG 2 regression: adopted server (loadedEngine=null) + toggle=hipfire stays available, not blocked", async () => {
    // readyServer() doesn't set loadedEngine — it stays null (adopted: we
    // never launched this server). The toggle alone must not block it.
    readyServer();
    useAppStore.getState().setSettings({
      ...useAppStore.getState().settings,
      engine_kind: "hipfire",
    });
    expect(useAppStore.getState().loadedEngine).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => fakeRes(["data: [DONE]\n"])));
    await useAppStore.getState().startTranscribe({ audioPath: "/a.wav", prompt: "go" });
    expect(useAppStore.getState().trError).toBeNull();
  });
});
