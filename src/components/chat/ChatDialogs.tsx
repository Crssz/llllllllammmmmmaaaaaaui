import { useEffect, useRef, useState } from "react";
import { I } from "../../icons";
import type { PendingToolApproval, PendingUserChoice } from "../../state";

// The tool-approval + ask-user native <dialog>s. Split out of the chat screen
// so the screen body stays about composition. Escape semantics differ per
// dialog and are preserved here:
//   • approval — Escape denies (approval is a deliberate choice)
//   • ask      — Escape dismisses the question with no answer
export function ChatDialogs({
  pendingToolApproval,
  approveTool,
  pendingUserChoice,
  answerUserChoice,
}: Readonly<{
  pendingToolApproval: PendingToolApproval | null;
  approveTool: (id: string, decision: "allow" | "deny", remember?: boolean) => void;
  pendingUserChoice: PendingUserChoice | null;
  answerUserChoice: (id: string, choice: string | null) => void;
}>) {
  const approvalRef = useRef<HTMLDialogElement | null>(null);
  const askRef = useRef<HTMLDialogElement | null>(null);

  // Drive the tool-approval modal as a native <dialog>: showModal() gives us
  // the backdrop, Escape-to-close, and focus trapping for free.
  useEffect(() => {
    const dlg = approvalRef.current;
    if (!dlg) return;
    if (pendingToolApproval && !dlg.open) dlg.showModal();
    else if (!pendingToolApproval && dlg.open) dlg.close();
  }, [pendingToolApproval]);

  // Same native-<dialog> treatment for the built-in ask_user question prompt.
  useEffect(() => {
    const dlg = askRef.current;
    if (!dlg) return;
    if (pendingUserChoice && !dlg.open) dlg.showModal();
    else if (!pendingUserChoice && dlg.open) dlg.close();
  }, [pendingUserChoice]);

  return (
    <>
      <dialog
        ref={approvalRef}
        className="tool-approval-card"
        onCancel={(e) => {
          // Escape key: treat as deny rather than a bare close. Approval is a
          // deliberate choice, so there is no click-outside-to-dismiss — the
          // explicit Deny button and Escape are the two ways out.
          e.preventDefault();
          if (pendingToolApproval) approveTool(pendingToolApproval.id, "deny");
        }}
      >
        {pendingToolApproval && (
          <>
            <div className="tool-approval-head">
              <I.Lock size={14} />
              <span>Approve tool call?</span>
            </div>
            <div className="tool-approval-body">
              <div className="tool-approval-row">
                <span className="lbl">Server</span>
                <span className="val mono">{pendingToolApproval.serverName}</span>
              </div>
              <div className="tool-approval-row">
                <span className="lbl">Tool</span>
                <span className="val mono">{pendingToolApproval.toolName}</span>
              </div>
              <div className="tool-approval-row" style={{ alignItems: "flex-start" }}>
                <span className="lbl">Arguments</span>
                <pre className="val mono tool-approval-args">
                  {JSON.stringify(pendingToolApproval.args, null, 2)}
                </pre>
              </div>
            </div>
            <ApprovalFooter
              onDecide={(decision, remember) =>
                approveTool(pendingToolApproval.id, decision, remember)
              }
            />
          </>
        )}
      </dialog>
      <dialog
        ref={askRef}
        className="tool-approval-card"
        onCancel={(e) => {
          // Escape dismisses the question without an answer (the model is told
          // it was dismissed). There's no click-outside-to-close.
          e.preventDefault();
          if (pendingUserChoice) answerUserChoice(pendingUserChoice.id, null);
        }}
      >
        {pendingUserChoice && (
          <>
            <div className="tool-approval-head">
              <I.Chat size={14} />
              <span>The model is asking</span>
            </div>
            <div className="tool-approval-body">
              <div className="ask-question">{pendingUserChoice.question}</div>
              <div className="ask-choices">
                {pendingUserChoice.choices.map((choice, i) => (
                  <button
                    key={i}
                    className="btn ask-choice"
                    onClick={() => answerUserChoice(pendingUserChoice.id, choice)}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            </div>
            <div className="tool-approval-foot">
              <button
                className="btn ghost"
                style={{ marginLeft: "auto" }}
                onClick={() => answerUserChoice(pendingUserChoice.id, null)}
              >
                <I.X size={11} /> Dismiss
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}

function ApprovalFooter({
  onDecide,
}: Readonly<{
  onDecide: (decision: "allow" | "deny", remember: boolean) => void;
}>) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="tool-approval-foot">
      <label className="mcp-check" style={{ marginRight: "auto" }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{" "}
        Remember for this session
      </label>
      <button className="btn" onClick={() => onDecide("deny", remember)}>
        <I.X size={11} /> Deny
      </button>
      <button className="btn primary" onClick={() => onDecide("allow", remember)}>
        <I.Check size={11} /> Allow
      </button>
    </div>
  );
}
