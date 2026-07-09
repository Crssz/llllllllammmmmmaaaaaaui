import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type ConfirmOptions = {
  title: string; // e.g. `Delete "My chat"?`
  body?: string; // optional explanatory sentence
  confirmLabel?: string; // default "Confirm"
  danger?: boolean; // red confirm button when true
};

type ConfirmRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

/** App-styled replacement for window.confirm(). Returns an element to mount
 *  locally plus an imperative `confirm()` that resolves true on confirm and
 *  false on cancel / Esc / backdrop click. Mirrors useTextPrompt's shape. */
export function useConfirm(): {
  confirmElement: ReactNode;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
} {
  const [req, setReq] = useState<ConfirmRequest | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setReq({ ...opts, resolve });
      }),
    [],
  );

  const confirmElement = req ? (
    <ConfirmDialog
      request={req}
      onDone={(ok) => {
        setReq(null);
        req.resolve(ok);
      }}
    />
  ) : null;

  return { confirmElement, confirm };
}

function ConfirmDialog({
  request,
  onDone,
}: Readonly<{
  request: ConfirmRequest;
  onDone: (ok: boolean) => void;
}>) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Drive as a native <dialog> via showModal(): backdrop, Esc-to-close, and
  // focus trapping come for free (matches the tool-approval modal convention).
  // For a danger action, focus Cancel as the safe default so Enter cancels;
  // otherwise focus Confirm so Enter confirms.
  const { danger } = request;
  const settle = useCallback((ok: boolean) => onDone(ok), [onDone]);
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    const focusTarget = danger ? cancelRef.current : confirmRef.current;
    focusTarget?.focus();
  }, [danger]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-card"
      onCancel={(e) => {
        // Esc: cancel. Prevent the native close so we resolve exactly once
        // through onDone (which also unmounts this dialog).
        e.preventDefault();
        settle(false);
      }}
      onMouseDown={(e) => {
        // A mousedown whose target is the dialog element itself (not a child)
        // landed on the ::backdrop, since the card fills the box with padding:0.
        if (e.target === dialogRef.current) settle(false);
      }}
    >
      <div className="confirm-body">
        <div className="confirm-title">{request.title}</div>
        {request.body && <div className="confirm-text">{request.body}</div>}
      </div>
      <div className="confirm-foot">
        <button ref={cancelRef} className="btn ghost" onClick={() => settle(false)}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          className={danger ? "btn danger" : "btn primary"}
          onClick={() => settle(true)}
        >
          {request.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </dialog>
  );
}
