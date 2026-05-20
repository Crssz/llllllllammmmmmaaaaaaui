# Helm

[![CI](https://github.com/narawit/helm/actions/workflows/ci.yml/badge.svg)](https://github.com/narawit/helm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue)

A Tauri desktop app for self-managing the `llama.cpp` binary — Linear/Raycast-adjacent UI with four screens: Chat, Configure (live `llama-server` command preview), Hardware (GPU/CPU/RAM readouts), and Profiles. MTP speculative decoding is wired across every surface.

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
  data.ts              — model, profiles, hardware, llama.cpp flag schema
  icons.tsx            — stroked Lucide-style icons
  styles.css           — the design system (oklch tokens, components)
  screens/
    Chat.tsx
    Configure.tsx      — live command builder, MTP / draft-model modes
    Hardware.tsx       — sparklines, GPU/RAM map, speculative-decoding stats
    Profiles.tsx
src-tauri/             — Rust shell + tauri.conf.json
```

## Pilot modes

The `Manual / Suggest / Auto` pills in the top bar control how aggressively the agent tunes the binary. In **Auto**, sliders with a `suggest` value get locked and marked with an accent line; in **Suggest**, ghost recommendations appear inline (`→ 100`).

## First-time setup

1. Build `llama.cpp` somewhere on disk (`cmake -B build && cmake --build build --config Release`).
2. Launch Helm, go to **Configure → Binary**, click **Browse…** and pick your `llama.cpp/build` directory.
3. Helm probes `./`, `bin/`, `bin/Release/`, `Release/` and runs `llama-server --version` to detect the build version, commit, and backend (CUDA / Vulkan / Metal / ROCm / CPU).
4. Click **Browse…** next to the `--model` row to pick a GGUF file.
5. Hit **Start** in the Configure page header. The TopBar dot turns green and the sidebar runtime card shows the real PID + uptime.

Settings persist to `%APPDATA%\dev.helm.app\settings.json` (build dir, recent dirs, model path, flag values).

## Tauri commands

| Command            | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `load_settings`    | Read settings.json                                |
| `save_settings`    | Persist settings.json                             |
| `add_recent_dir`   | Push directory to recent list (de-dup, max 5)     |
| `scan_build`       | Probe a directory for llama.cpp binaries + version|
| `start_server`     | Spawn `llama-server` with the assembled argv      |
| `stop_server`      | Kill the child process                            |
| `server_status`    | Poll running/PID/port                             |
