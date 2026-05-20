# Security policy

## Supported versions

Only the latest `0.x` release is actively maintained. Older versions do not receive security fixes.

## Reporting a vulnerability

Email **narawittriprom@gmail.com** with:

- A short description of the issue and its impact
- Steps to reproduce (or a proof-of-concept if one exists)
- The version of llllllllammmmmmaaaaaaui you tested against
- Your environment (OS build, Rust toolchain if relevant)

Please do **not** open a public GitHub issue for unpatched security problems.

You'll get a first response within 7 days. Once a fix lands, we'll disclose the issue alongside the release.

## Threat model — what llllllllammmmmmaaaaaaui does and doesn't protect against

llllllllammmmmmaaaaaaui is a local desktop app that spawns `llama-server` and reads GGUF files from disk. It is **not** designed to defend against:

- A malicious local user with read/write access to your `%APPDATA%\dev.llllllllammmmmmaaaaaaui.app\` directory (settings/chats live there in cleartext).
- A malicious `llama.cpp` build binary you point llllllllammmmmmaaaaaaui at — llllllllammmmmmaaaaaaui executes whatever `llama-server.exe` it finds in the configured build directory.
- A malicious GGUF file you load — the parser limits string sizes (16 MB) and rejects unknown types, but new tensor formats may surface bugs.

It *does* defend against:

- Path-traversal escapes in user-supplied scan directories (`canonical_dir` rejects non-existent / non-directory targets).
- Mutex panics taking down the app (`lock_or_poisoned` recovers).
- A Tauri frontend supply-chain compromise reading arbitrary resources — see the `csp` field in `tauri.conf.json`.

If you find a way to escape any of those guarantees, that's in scope for a report.
