import { useCallback, useEffect, useState, type ReactNode } from "react";
import { I } from "../icons";

export type TextPromptRequest = {
  title: string;
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
};

/** Small centered input dialog — the app-styled replacement for
 *  window.prompt() (which WebViews don't reliably support). Returns the
 *  element to mount plus a function that opens it. */
export function useTextPrompt(): {
  promptElement: ReactNode;
  openPrompt: (req: TextPromptRequest) => void;
} {
  const [req, setReq] = useState<TextPromptRequest | null>(null);
  const openPrompt = useCallback((r: TextPromptRequest) => setReq(r), []);
  const promptElement = req ? (
    <TextPromptDialog
      request={req}
      onClose={() => setReq(null)}
      onSubmit={(v) => {
        setReq(null);
        req.onSubmit(v);
      }}
    />
  ) : null;
  return { promptElement, openPrompt };
}

function TextPromptDialog({
  request,
  onSubmit,
  onClose,
}: Readonly<{
  request: TextPromptRequest;
  onSubmit: (value: string) => void;
  onClose: () => void;
}>) {
  const [value, setValue] = useState(request.initial ?? "");
  const commit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
  };

  // Escape closes even when focus has left the input (e.g. after clicking
  // the backdrop or a button without activating it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(0,0,0,0.35)",
        backdropFilter: "blur(2px)",
        display: "grid",
        placeItems: "center",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 380,
          maxWidth: "calc(100vw - 40px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-pop)",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
          <I.Pencil size={13} style={{ color: "var(--muted)" }} />
          <span style={{ flex: 1, fontSize: 13 }}>{request.title}</span>
          <button
            className="iconbtn"
            title="Cancel"
            onClick={onClose}
            style={{ width: 22, height: 22 }}
          >
            <I.X size={11} />
          </button>
        </div>
        <input
          className="input"
          autoFocus
          placeholder={request.placeholder ?? ""}
          value={value}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onClose();
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={commit}>
            <I.Check size={11} /> {request.submitLabel ?? "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
