import { useMemo, useState } from "react";
import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";

function fmtN(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  if (typeof n !== "number") return String(n);
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k";
  return String(n);
}

function basename(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  return p.split(sep).pop() || p;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function ProfilesScreen() {
  const { settings, flags, saveProfile, loadProfile, deleteProfile } = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      flags: s.flags,
      saveProfile: s.saveProfile,
      loadProfile: s.loadProfile,
      deleteProfile: s.deleteProfile,
    })),
  );
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");

  const profiles = settings.profiles;
  const filtered = useMemo(
    () =>
      profiles.filter(
        (p) => !q || (p.name + " " + (p.model_path ?? "")).toLowerCase().includes(q.toLowerCase()),
      ),
    [profiles, q],
  );

  const handleSave = async () => {
    const trimmed = name.trim() || defaultProfileName(flags);
    await saveProfile(trimmed);
    setName("");
    setCreating(false);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Profiles</div>
          <h1>Saved runtime profiles</h1>
        </div>
        <div className="head-meta">
          <button
            className="btn primary"
            onClick={() => {
              setCreating(true);
              setName(defaultProfileName(flags));
            }}
          >
            <I.Plus size={12} /> Save current as profile
          </button>
        </div>
      </div>

      {creating && (
        <div
          style={{
            margin: "10px 28px 0",
            padding: "12px 14px",
            background: "var(--surface)",
            border: "1px solid var(--accent-line)",
            borderRadius: "var(--radius)",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <I.Bookmark size={14} style={{ color: "var(--accent)" }} />
          <input
            className="input"
            autoFocus
            placeholder="Profile name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              else if (e.key === "Escape") {
                setCreating(false);
                setName("");
              }
            }}
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={() => setCreating(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={handleSave}>
            <I.Check size={11} /> Save
          </button>
        </div>
      )}

      <div className="page-body">
        <div className="prof-toolbar">
          <div className="prof-search">
            <I.Search />
            <input
              placeholder="Search by name, tag, model…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <span className="badge ghost mono">
            {filtered.length} of {profiles.length}
          </span>
          <span style={{ flex: 1 }} />
          <div className="segmented">
            <button className={view === "grid" ? "on" : ""} onClick={() => setView("grid")}>
              grid
            </button>
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>
              list
            </button>
          </div>
        </div>

        {profiles.length === 0 && (
          <div
            style={{
              padding: "40px 24px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
              border: "1px dashed var(--border)",
              borderRadius: "var(--radius-lg)",
            }}
          >
            No saved profiles yet — set up flags on Configure, then click
            <b style={{ color: "var(--text-2)" }}> Save current as profile</b>.
          </div>
        )}

        <div
          className="prof-grid"
          style={view === "list" ? { gridTemplateColumns: "1fr" } : undefined}
        >
          {filtered.map((p) => {
            const f = (p.flags ?? {}) as Record<string, unknown>;
            const modelDisplay = p.model_path ? basename(p.model_path) : "no model";
            return (
              <div key={p.id} className="prof-card">
                <div className="prof-card-head">
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div className="prof-name">{p.name}</div>
                    <div className="prof-meta mono" title={p.model_path ?? ""}>
                      {modelDisplay}
                      {p.agency ? ` · ${p.agency}` : ""}
                    </div>
                  </div>
                  <button
                    className="iconbtn more"
                    title="Delete profile"
                    onClick={() => {
                      if (confirm(`Delete profile "${p.name}"?`)) {
                        deleteProfile(p.id).catch(() => {});
                      }
                    }}
                  >
                    <I.X size={14} />
                  </button>
                </div>

                <div
                  style={{
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "6px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--muted)",
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: "2px 8px",
                  }}
                >
                  <span>
                    ctx{" "}
                    <span style={{ color: "var(--text-2)" }}>
                      {fmtN(f.ctx as number | undefined)}
                    </span>
                  </span>
                  <span>
                    ngl{" "}
                    <span style={{ color: "var(--text-2)" }}>
                      {f.ngl != null ? String(f.ngl) : "—"}
                    </span>
                  </span>
                  <span>
                    fa <span style={{ color: "var(--text-2)" }}>{f.fa ? "on" : "off"}</span>
                  </span>
                  <span>
                    ctk{" "}
                    <span style={{ color: "var(--text-2)" }}>
                      {f.ctk != null ? String(f.ctk) : "—"}
                    </span>
                  </span>
                  <span>
                    ctv{" "}
                    <span style={{ color: "var(--text-2)" }}>
                      {f.ctv != null ? String(f.ctv) : "—"}
                    </span>
                  </span>
                  <span>
                    batch{" "}
                    <span style={{ color: "var(--text-2)" }}>
                      {f.batch != null ? String(f.batch) : "—"}
                    </span>
                  </span>
                </div>

                <div className="prof-foot">
                  <span className="lastrun">saved {timeAgo(p.created_at)}</span>
                  <button
                    className="btn"
                    style={{ padding: "3px 10px" }}
                    onClick={() => loadProfile(p.id)}
                    title="Apply this profile's flags"
                  >
                    <I.Play size={11} /> Load
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function defaultProfileName(flags: Record<string, unknown>): string {
  const model = flags.model ? basename(flags.model as string).replace(".gguf", "") : "untitled";
  return model;
}
