import { useRef, useState, type HTMLAttributes, type ReactElement } from "react";
import { I } from "../../icons";
import { useContextMenu } from "../ContextMenu";

// Custom <pre> wrapper for code blocks: hides streamdown's built-in icons
// (we disable those via `controls={{ code: false }}` on the Streamdown root)
// and shows a hover-revealed Copy button instead.
export function CodeBlockPre(props: Readonly<HTMLAttributes<HTMLPreElement>>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const openMenu = useContextMenu();
  // Pull the language hint from the child <code className="language-xyz">.
  const child = props.children as ReactElement<{ className?: string }> | undefined;
  const langMatch = child?.props?.className && /language-(\S+)/.exec(child.props.className);
  const lang = langMatch?.[1] ?? "";

  const copy = () => {
    const text =
      preRef.current?.querySelector("code")?.textContent ?? preRef.current?.textContent ?? "";
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div
      className="md-codeblock"
      onContextMenu={(e) => openMenu(e, [{ label: "Copy code", icon: "Copy", onClick: copy }])}
    >
      {lang && <span className="md-codeblock-lang mono">{lang}</span>}
      <button
        type="button"
        className="md-copy-btn"
        onClick={copy}
        aria-label="Copy code"
        title="Copy code"
      >
        {copied ? (
          <>
            <I.Check size={11} /> Copied
          </>
        ) : (
          <>
            <I.Copy size={11} /> Copy
          </>
        )}
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}

export const STREAMDOWN_COMPONENTS = { pre: CodeBlockPre } as const;
