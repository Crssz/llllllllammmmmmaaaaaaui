# Contributing

Thanks for your interest. This is a small Tauri + React app; the contribution loop is short.

## Setup

```pwsh
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is needed because some plugins haven't published peer-dep ranges for ESLint 9.

## Quality gates

Run before opening a PR:

```pwsh
npm run lint
npm run format:check
npm run typecheck
npm test
cd src-tauri
cargo fmt --check
cargo clippy --lib --tests
cargo test --lib
```

CI runs the same set on Windows.

## Style

- TypeScript: ESLint + Prettier configs are committed; let them auto-fix.
- Rust: `rustfmt` defaults (`rustfmt.toml` is minimal).
- Don't add `--no-mmap`-style flags to `buildArgs` without a test in `src/lib/buildArgs.test.ts`.

## Filing issues

Reproduction info we need:
- OS + Windows build number
- `llama.cpp` build version (visible on the Configure → Binary tab after a scan)
- GPU + driver, if the issue involves hardware detection
- Whether NVML / HIP loaded (visible in the Logs panel: `Ctrl+\``)
