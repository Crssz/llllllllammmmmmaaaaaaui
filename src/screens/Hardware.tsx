import { I } from "../icons";
import { useAppStore } from "../state";
import { useShallow } from "zustand/react/shallow";

function Sparkline({
  data,
  color = "var(--accent)",
  height = 32,
}: Readonly<{
  data: number[];
  color?: string;
  height?: number;
}>) {
  const w = 100;
  const h = height;
  if (data.length === 0) {
    return <div style={{ height }} />;
  }
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const pad = 2;
  const xs = (i: number) =>
    data.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (data.length - 1);
  const ys = (v: number) => h - pad - ((v - min) / Math.max(0.0001, max - min)) * (h - pad * 2);
  const path = data
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`)
    .join(" ");
  const area = `${path} L ${xs(data.length - 1).toFixed(1)} ${h} L ${pad} ${h} Z`;
  const gid = `g-${color.replaceAll(/[^a-z]/gi, "")}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function HardwareScreen() {
  const { hw, hwSeries, server } = useAppStore(
    useShallow((s) => ({ hw: s.hw, hwSeries: s.hwSeries, server: s.server })),
  );

  const gpu0 = hw?.gpus?.[0];
  const gpuVramPct =
    gpu0 && gpu0.vram_total_gb > 0 ? (gpu0.vram_used_gb / gpu0.vram_total_gb) * 100 : 0;
  const ramPct = hw && hw.ram_total_gb > 0 ? (hw.ram_used_gb / hw.ram_total_gb) * 100 : 0;
  const noGpu = !gpu0;
  const backend = hw?.gpu_backend ?? "—";
  const isHipBackend = backend.startsWith("HIP");
  // Tooltip for the one field still unavailable on AMD: power draw in watts
  // (the WDDM kernel exposes temperature and clock, but not absolute watts).
  const tipMissing = isHipBackend
    ? "Power draw in watts isn't exposed for these GPUs via the WDDM kernel. Install amd-smi to populate it."
    : undefined;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumb">Hardware / live</div>
          <h1>Resource readout</h1>
        </div>
        <div className="head-meta">
          <span
            className="badge ghost mono"
            title={
              isHipBackend
                ? "AMD GPU detected. VRAM total via HIP; usage & utilization via WMI; temperature & clock via the WDDM kernel."
                : backend === "NVML"
                  ? "NVIDIA GPU detected via NVML."
                  : "No GPU backend available."
            }
          >
            backend: {backend}
          </span>
          <span className="badge ghost">
            <I.Refresh size={11} /> 1s
          </span>
        </div>
      </div>

      <div className="page-body">
        <div className="hw-grid">
          <div className="stat-card">
            <div className="label">
              <I.Gpu /> VRAM · {gpu0 ? "GPU 0" : "—"}
            </div>
            <div className="big">
              {gpu0 ? gpu0.vram_used_gb.toFixed(1) : "—"}
              <span className="unit">{gpu0 ? `/ ${gpu0.vram_total_gb.toFixed(0)} GB` : ""}</span>
            </div>
            <div className="util-bar">
              <i style={{ width: gpuVramPct + "%" }} />
            </div>
            <div className="spark">
              <Sparkline data={hwSeries.vram} color="oklch(0.72 0.17 290)" />
            </div>
            <div className="sub">
              {gpu0 ? (
                <>
                  <span>{gpuVramPct.toFixed(0)}% used</span>
                  <span>{(gpu0.vram_total_gb - gpu0.vram_used_gb).toFixed(1)} GB free</span>
                </>
              ) : (
                <span>no GPU detected</span>
              )}
            </div>
          </div>

          <div className="stat-card">
            <div className="label">
              <I.Gpu /> GPU utilization
            </div>
            <div className="big">
              {gpu0?.util ?? "—"}
              <span className="unit">%</span>
            </div>
            <div className="util-bar">
              <i style={{ width: (gpu0?.util ?? 0) + "%" }} />
            </div>
            <div className="spark">
              <Sparkline data={hwSeries.gpu} color="var(--cyan)" />
            </div>
            <div className="sub">
              {gpu0 ? (
                <>
                  <span
                    title={gpu0.clock_mhz == null ? tipMissing : undefined}
                    style={
                      gpu0.clock_mhz == null
                        ? { cursor: "help", textDecoration: "underline dotted" }
                        : undefined
                    }
                  >
                    {gpu0.clock_mhz != null ? `${gpu0.clock_mhz} MHz` : "— MHz"}
                  </span>
                  <span
                    title={gpu0.power_w == null ? tipMissing : undefined}
                    style={
                      gpu0.power_w == null
                        ? { cursor: "help", textDecoration: "underline dotted" }
                        : undefined
                    }
                  >
                    {gpu0.power_w != null ? `${gpu0.power_w} W` : "— W"}
                  </span>
                </>
              ) : (
                <span>no GPU backend</span>
              )}
            </div>
          </div>

          <div className="stat-card">
            <div className="label">
              <I.Cpu /> CPU utilization
            </div>
            <div className="big">
              {hw ? hw.cpu_util.toFixed(0) : "—"}
              <span className="unit">%</span>
            </div>
            <div className="util-bar">
              <i style={{ width: (hw?.cpu_util ?? 0) + "%" }} />
            </div>
            <div className="spark">
              <Sparkline data={hwSeries.cpu} color="var(--green)" />
            </div>
            <div className="sub">
              <span>{hw?.cpu_cores ?? "—"} logical</span>
              <span>{hw ? `${hw.cpu_freq_ghz.toFixed(2)} GHz` : "—"}</span>
            </div>
          </div>

          <div className="stat-card">
            <div className="label">
              <I.Mem /> RAM
            </div>
            <div className="big">
              {hw ? hw.ram_used_gb.toFixed(1) : "—"}
              <span className="unit">{hw ? `/ ${hw.ram_total_gb.toFixed(0)} GB` : ""}</span>
            </div>
            <div className="util-bar">
              <i style={{ width: ramPct + "%" }} />
            </div>
            <div className="spark">
              <Sparkline data={hwSeries.ram} color="oklch(0.82 0.14 85)" />
            </div>
            <div className="sub">
              <span>{ramPct.toFixed(0)}% used</span>
              <span>swap {hw ? hw.swap_used_gb.toFixed(1) : "—"} GB</span>
            </div>
          </div>
        </div>

        <div className="hw-row">
          <div className="panel">
            <div className="panel-head">
              <I.Gpu size={14} /> GPU breakdown
              <span className="meta">
                {hw?.gpus?.length ?? 0} device{(hw?.gpus?.length ?? 0) === 1 ? "" : "s"}
              </span>
            </div>
            <div
              className="panel-body"
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              {noGpu && (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  No GPU backend available. NVIDIA: install drivers (NVML). AMD on Windows: point
                  Configure → Binary at a llama.cpp ROCm build that contains{" "}
                  <span className="mono">amdhip64_7.dll</span>.
                </div>
              )}
              {isHipBackend && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--muted)",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "6px 10px",
                  }}
                >
                  <I.Info size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                  {backend.includes("WDDM") ? (
                    <>
                      AMD detected. VRAM total via the HIP runtime; usage &amp; utilization via WMI;{" "}
                      <strong>temperature &amp; clock via the WDDM kernel</strong> — the same source
                      Task Manager uses. Only power draw in watts is unavailable; install amd-smi
                      for it.
                    </>
                  ) : backend === "HIP + WMI" ? (
                    <>
                      AMD detected. VRAM total via HIP runtime; usage &amp; utilization via WMI perf
                      counters. <strong>Temperature, power, and clock</strong> need amd-smi on this
                      machine.
                    </>
                  ) : (
                    <>
                      AMD detected via HIP runtime. Only VRAM is exposed; install amd-smi for
                      utilization, temperature, power, and clock readings.
                    </>
                  )}
                </div>
              )}
              {hw?.gpus?.map((g, i) => {
                const pct = g.vram_total_gb > 0 ? (g.vram_used_gb / g.vram_total_gb) * 100 : 0;
                const fmt = (v: number | null, unit: string) =>
                  v != null ? `${v}${unit}` : `—${unit}`;
                return (
                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="badge ghost mono">GPU{i}</span>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{g.name}</span>
                      <span
                        style={{
                          marginLeft: "auto",
                          cursor: g.temp_c == null || g.power_w == null ? "help" : "default",
                        }}
                        className="mono badge ghost"
                        title={g.temp_c == null || g.power_w == null ? tipMissing : undefined}
                      >
                        {fmt(g.temp_c, "°C")} · {fmt(g.power_w, "W")}
                      </span>
                    </div>
                    <div className="mem-map">
                      <div
                        className="mem-block"
                        style={
                          {
                            "--w": pct,
                            background: "var(--accent)",
                          } as React.CSSProperties
                        }
                      >
                        used
                      </div>
                      <div
                        className="mem-block"
                        style={
                          {
                            "--w": Math.max(0, 100 - pct),
                            background: "var(--surface-2)",
                          } as React.CSSProperties
                        }
                      />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 11.5,
                        color: "var(--muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      <span>
                        {g.vram_used_gb.toFixed(1)} / {g.vram_total_gb.toFixed(0)} GB ·{" "}
                        {pct.toFixed(0)}%
                      </span>
                      <span>
                        util {fmt(g.util, "%")} · {fmt(g.clock_mhz, " MHz")}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <I.Mem size={14} /> System RAM
              <span className="meta">{hw ? `${hw.ram_total_gb.toFixed(0)} GB total` : "—"}</span>
            </div>
            <div
              className="panel-body"
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <span className="mono" style={{ fontSize: 22 }}>
                  {hw ? hw.ram_used_gb.toFixed(1) : "—"}{" "}
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>GB used</span>
                </span>
                <span className="badge ghost mono">{ramPct.toFixed(0)}%</span>
              </div>
              <div className="mem-map" style={{ height: 14 }}>
                <div
                  className="mem-block"
                  style={
                    {
                      "--w": ramPct,
                      background: "var(--accent)",
                    } as React.CSSProperties
                  }
                />
                <div
                  className="mem-block"
                  style={
                    {
                      "--w": Math.max(0, 100 - ramPct),
                      background: "var(--surface-2)",
                    } as React.CSSProperties
                  }
                />
              </div>
              <div className="mem-legend">
                <div>
                  <i style={{ background: "var(--accent)" }} /> used ·{" "}
                  {hw ? hw.ram_used_gb.toFixed(1) : "—"} GB
                </div>
                <div>
                  <i style={{ background: "var(--surface-2)" }} /> free ·{" "}
                  {hw ? (hw.ram_total_gb - hw.ram_used_gb).toFixed(1) : "—"} GB
                </div>
              </div>
              <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
              <div className="thr-grid">
                <div className="thr-row">
                  <span className="lbl">swap</span>
                  <div className="bar">
                    <i
                      style={{
                        width: `${Math.min(100, ((hw?.swap_used_gb ?? 0) * 100) / Math.max(1, hw?.ram_total_gb ?? 1))}%`,
                      }}
                    />
                  </div>
                  <span className="val">{hw ? hw.swap_used_gb.toFixed(1) : "—"} GB</span>
                </div>
                <div className="thr-row">
                  <span className="lbl">cpu</span>
                  <div className="bar">
                    <i
                      style={{
                        width: `${hw?.cpu_util ?? 0}%`,
                        background: "var(--green)",
                      }}
                    />
                  </div>
                  <span className="val">{hw ? hw.cpu_util.toFixed(0) : "—"}%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          className="panel"
          style={{
            marginTop: 8,
            opacity: 0.85,
          }}
        >
          <div className="panel-head">
            <I.Bolt size={14} /> Inference timings
            <span className="meta">stub — needs llama-server /metrics</span>
          </div>
          <div className="panel-body" style={{ fontSize: 12, color: "var(--muted)" }}>
            {server.running
              ? "llama-server is running. Inference stats (prompt eval / gen tok/s / spec accept) will populate once /metrics integration is wired."
              : "Start llama-server on the Configure tab to populate inference timings."}
          </div>
        </div>
      </div>
    </>
  );
}
