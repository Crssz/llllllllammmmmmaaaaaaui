import { useEffect, useState } from "react";
import { I } from "../../icons";
import { useContextMenu } from "../ContextMenu";
import { fmtRecDuration } from "../Recorder";
import { api, type AudioAttachment } from "../../lib/api";
import { basename } from "../../lib/chatUi";

// Lazy-load an audio attachment off disk via the existing Rust read command,
// wrap it in a Blob, and play through the standard <audio> control. Avoids
// widening Tauri's asset-protocol scope for chat playback. The blob URL is
// revoked when the component unmounts or the path changes.
export function MessageAudio({ audio }: Readonly<{ audio: AudioAttachment }>) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const openMenu = useContextMenu();

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErr(null);
    setUrl(null);
    api
      .readAudioBase64(audio.path)
      .then((payload) => {
        if (!alive) return;
        // base64 → Uint8Array → Blob URL. `atob` is fine here: WAV clips from
        // the recorder are small and the chat thread renders one at a time.
        const bin = atob(payload.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: `audio/${payload.format}` });
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [audio.path]);

  return (
    <div
      className="msg-audio"
      onContextMenu={(e) =>
        openMenu(e, [
          {
            label: "Copy file path",
            icon: "Copy",
            onClick: () => navigator.clipboard?.writeText(audio.path).catch(() => {}),
          },
          {
            label: "Reveal in Explorer",
            icon: "Folder",
            onClick: () => api.revealInExplorer(audio.path).catch(() => {}),
          },
        ])
      }
    >
      <I.Mic size={12} style={{ color: "var(--accent)" }} />
      {url ? (
        <audio controls preload="metadata" src={url} />
      ) : err ? (
        <span className="tr-rec-err" title={err}>
          audio unavailable
        </span>
      ) : (
        <span className="msg-audio-dur mono">loading…</span>
      )}
      {audio.duration_ms != null && (
        <span className="msg-audio-dur mono">{fmtRecDuration(audio.duration_ms)}</span>
      )}
      <span
        className="mono msg-audio-dur"
        title={audio.path}
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 180,
        }}
      >
        {basename(audio.path)}
      </span>
    </div>
  );
}
