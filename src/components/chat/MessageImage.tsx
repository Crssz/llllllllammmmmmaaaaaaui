import { useEffect, useState } from "react";
import { I } from "../../icons";
import { useContextMenu } from "../ContextMenu";
import { api, type ImageAttachment } from "../../lib/api";
import { basename } from "../../lib/chatUi";

// Lazy-load an image attachment off disk via the Rust read command and render
// it as a data URL (CSP already allows `img-src 'self' data: blob:`). Clicking
// the thumbnail opens a full-size overlay. Mirrors MessageAudio's lazy load so
// we don't widen Tauri's asset-protocol scope.
export function MessageImage({ image }: Readonly<{ image: ImageAttachment }>) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const openMenu = useContextMenu();

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErr(null);
    setSrc(null);
    api
      .readImageBase64(image.path)
      .then((payload) => {
        if (!alive) return;
        setSrc(`data:${payload.mime};base64,${payload.data}`);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [image.path]);

  return (
    <div
      className="msg-image"
      onContextMenu={(e) =>
        openMenu(e, [
          {
            label: "View full size",
            icon: "Image",
            disabled: !src,
            onClick: () => setZoomed(true),
          },
          "separator",
          {
            label: "Copy file path",
            icon: "Copy",
            onClick: () => navigator.clipboard?.writeText(image.path).catch(() => {}),
          },
          {
            label: "Reveal in Explorer",
            icon: "Folder",
            onClick: () => api.revealInExplorer(image.path).catch(() => {}),
          },
        ])
      }
    >
      {src ? (
        <button
          type="button"
          className="msg-image-thumb-btn"
          onClick={() => setZoomed(true)}
          title="Click to enlarge"
        >
          <img className="msg-image-thumb" src={src} alt={basename(image.path)} />
        </button>
      ) : err ? (
        <span className="tr-rec-err" title={err}>
          <I.Image size={12} /> image unavailable
        </span>
      ) : (
        <span className="msg-audio-dur mono">
          <I.Image size={12} /> loading…
        </span>
      )}
      <span
        className="mono msg-audio-dur"
        title={image.path}
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 180,
        }}
      >
        {basename(image.path)}
      </span>
      {zoomed && src && (
        <button
          type="button"
          className="msg-image-overlay"
          onClick={() => setZoomed(false)}
          title="Click to close"
        >
          <img src={src} alt={basename(image.path)} />
        </button>
      )}
    </div>
  );
}
