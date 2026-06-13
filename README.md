# llllllllammmmmmaaaaaaui

[![CI](https://github.com/Crssz/llllllllammmmmmaaaaaaui/actions/workflows/ci.yml/badge.svg)](https://github.com/Crssz/llllllllammmmmmaaaaaaui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue)

A Tauri desktop app for self-managing the `llama.cpp` toolchain — a Linear/Raycast-adjacent UI for picking a build, launching `llama-server`, chatting against it, benchmarking throughput, and watching your hardware. MTP speculative decoding is wired across every surface.

## Screens

- **Chat** — streaming chat against the running `llama-server`, with image/audio attachments, MCP tool calls, and built-in workspace file tools when a project folder is opened.
- **Models** — scan a models directory, browse the GGUF library, and inspect model metadata.
- **Configure** — live `llama-server` command builder for every flag, MTP / draft-model modes, and the build/binary locator.
- **Hardware** — live GPU / CPU / RAM telemetry with sparklines.
- **Profiles** — save and restore flag presets.
- **MCP** — manage MCP servers (stdio / http / sse), connect, and list/call their tools.
- **Audio** — in-app microphone capture for transcription.
- **Bench** — run `llama-bench`, compare prompt-processing / generation throughput across configs, and keep a persisted run history.

## Stack

- **Frontend:** Vite + React 18 + TypeScript
- **Shell:** Tauri v2 (Rust)
- **Styling:** plain CSS, oklch palette, Inter + JetBrains Mono

## Run

```pwsh
npm install
npm run tauri:dev      # desktop window
# or
npm run dev            # browser at http://localhost:1420
```

## Build

```pwsh
npm run tauri:build    # produces an installer under src-tauri/target/release/bundle/
```

### Windows build prerequisites

- **Rust** stable toolchain (`rustup install stable`)
- **MSVC build tools** — install the "Desktop development with C++" workload via Visual Studio Build Tools 2022
- **WebView2 runtime** — pre-installed on Windows 11; on Windows 10 install from [Microsoft's WebView2 page](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
- **Node.js 20+**

### Code signing (optional)

`src-tauri/tauri.conf.json` declares the digest algorithm and timestamp URL but no certificate thumbprint. To produce a signed MSI, set environment variables before running `tauri build`:

```pwsh
$env:TAURI_SIGNING_PRIVATE_KEY = "..."        # base64-encoded .pfx
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."
npm run tauri:build
```

Without those variables the build still succeeds and produces an unsigned MSI/NSIS installer.

## Quality gates

```pwsh
npm run typecheck         # tsc --noEmit
npm run lint              # eslint
npm run format:check      # prettier --check
npm test                  # vitest
cd src-tauri
cargo fmt --check
cargo clippy --lib --tests
cargo test --lib
```

The same checks run in CI on every push and PR — see `.github/workflows/ci.yml`.

## Release process

1. Bump the version in three files (must stay in sync): `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. Commit and tag: `git tag v0.5.0 && git push --tags`.
3. The `release.yml` workflow builds the Windows MSI + NSIS installers and attaches them to a GitHub Release for that tag.

## Project layout

```
src/
  App.tsx              — TopBar, Sidebar, StatusBar, screen routing
  data.ts              — llama.cpp flag schema (FLAG_GROUPS) + seed data
  icons.tsx            — stroked Lucide-style icons
  styles.css           — the design system (oklch tokens, components)
  screens/             — Chat, Models, Configure, Hardware, Profiles, Mcp,
                         Transcribe (Audio), Bench, BinaryLocator
  state/               — Zustand store split into slices/, plus effects.tsx
                         (event listeners + polling) and persist.ts
  lib/                 — api.ts (Tauri command wrappers), buildArgs.ts,
                         logger, series, chat/workspace/audio helpers
  components/          — LogsPanel, ModelLibraryOverlay, Toasts, ChatSidebar…
src-tauri/
  src/                 — Rust shell: one module per domain (server, bench,
                         hw, gguf, mcp, chats, models_scan, build_scan,
                         settings, transcribe, workspace) + lib.rs (wiring)
  tauri.conf.json      — app config
```

## First-time setup

1. Build `llama.cpp` somewhere on disk (`cmake -B build && cmake --build build --config Release`).
2. Launch llllllllammmmmmaaaaaaui, go to **Configure → Binary**, click **Browse…** and pick your `llama.cpp/build` directory.
3. llllllllammmmmmaaaaaaui probes `./`, `bin/`, `bin/Release/`, `Release/` and runs `llama-server --version` to detect the build version, commit, and backend (CUDA / Vulkan / Metal / ROCm / CPU).
4. Click **Browse…** next to the `--model` row to pick a GGUF file.
5. Hit **Start** in the Configure page header. The TopBar dot turns green and the sidebar runtime card shows the real PID + uptime.

Settings persist to `%APPDATA%\dev.llllllllammmmmmaaaaaaui.app\settings.json` (build dir, recent dirs, model path, flag values).

## Tauri commands

| Area     | Commands                                                                   | Purpose                                                              |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Settings | `load_settings`, `save_settings`, `add_recent_dir`, `add_recent_models_dir` | Read/persist settings.json; track recent build/model dirs           |
| Build    | `scan_build`                                                              | Probe a directory for llama.cpp binaries + version/backend          |
| Models   | `scan_models`, `inspect_gguf`                                             | Scan a models dir; read GGUF metadata (arch, MTP, mmproj, thinking) |
| Server   | `start_server`, `stop_server`, `server_status`                           | Spawn/kill `llama-server` with the assembled argv; poll PID/port    |
| Hardware | `hw_snapshot`                                                             | Poll GPU/CPU/RAM telemetry                                          |
| Chats    | `load_chats`, `save_chats`                                                | Persist chat sessions to chats.json                                 |
| Media    | `save_recording`, `read_audio_base64`, `read_image_base64`               | Persist mic recordings; base64-encode audio/images for the model   |
| MCP      | `mcp_connect`, `mcp_disconnect`, `mcp_list_tools`, `mcp_call_tool`, `mcp_status_all` | Manage MCP servers and invoke their tools               |
| Bench    | `run_bench`, `cancel_bench`, `load_bench_runs`, `save_bench_runs`        | Run/cancel `llama-bench`; persist run history to bench_runs.json    |
| Workspace| `workspace_list`, `workspace_read`, `workspace_write`, `workspace_edit`, `workspace_search`, `workspace_find` | Built-in file tools rooted at a chat's project folder |
