# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Production-hardening pass: ESLint + Prettier, Vitest (17 frontend tests),
  Rust unit tests (13 cases), GitHub Actions CI on Windows, and a tag-triggered
  release workflow that builds MSI + NSIS installers.
- `lock_or_poisoned()` helper recovers from poisoned mutexes instead of
  crashing.
- `canonical_dir()` rejects path-traversal escapes before reading the
  filesystem.
- Model-path existence check before spawning llama-server.
- Structured-logging surface for previously-silent persistence failures
  (`logFailure` helper in `src/lib/logger.ts`).
- Pure `buildArgs` module extracted from Configure screen for testability.
- Content-Security-Policy headers in Tauri config.
- LICENSE (MIT), CHANGELOG, CONTRIBUTING.

### Changed

- `npm run build` now type-checks via `tsc --noEmit` (was a no-op `tsc -b`).
- Windows bundle targets narrowed to NSIS + MSI; signing placeholders added.

### Fixed

- React `rules-of-hooks` violation in `App.tsx` (`useUptime` was conditionally
  called).
