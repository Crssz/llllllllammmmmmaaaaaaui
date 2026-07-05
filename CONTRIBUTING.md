# Contributing

Thanks for your interest. This is a small Tauri + React app; the contribution loop is short.

## Setup

```pwsh
npm install
```

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

## SonarQube Cloud

CI also runs static analysis and coverage on [SonarQube Cloud](https://sonarcloud.io)
via the `sonarqube` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
Config lives in [`sonar-project.properties`](sonar-project.properties).

One-time setup (maintainers):

1. Sign in to <https://sonarcloud.io> with GitHub and import the repository.
   Confirm the generated **Organization** and **Project Key** match
   `sonar.organization` / `sonar.projectKey` in `sonar-project.properties`.
2. In the SonarQube project, set **Analysis Method** to *CI-based* (GitHub
   Actions) so it does not also run automatic analysis.
3. Generate a token (My Account → Security) and add it to the repo as the
   `SONAR_TOKEN` Actions secret (Settings → Secrets and variables → Actions).

The Quality Gate is **report-only** by default — it reports status but does not
fail CI. To enforce it, remove the `continue-on-error: true` line from the
`Quality Gate check` step in the workflow.

To reproduce the TypeScript coverage Sonar consumes:

```pwsh
npm run coverage   # writes coverage/lcov.info
```

### Run analysis locally

You can run the full analysis on your own machine — no SonarQube Cloud account
needed. The free Community Build server covers both TypeScript and Rust (the
Rust analyzer runs Clippy).

1. Start a local server (needs Docker Desktop):

   ```pwsh
   docker compose -f docker-compose.sonar.yml up -d
   ```

   Open <http://localhost:9000>, log in as `admin` / `admin`, set a new
   password. Create a project with key `Crssz_llllllllammmmmmaaaaaaui` (matching
   `sonar-project.properties`) and generate a token under
   *My Account → Security*.

2. Install the [Sonar Scanner CLI](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/scanners/sonarscanner/).
   It needs a JDK 17+ on `PATH` (it does not bundle one):

   ```pwsh
   scoop bucket add java
   scoop install temurin21-jdk sonar-scanner
   ```

   Keep `cargo`/`clippy` on `PATH` too, so Rust gets analyzed.

3. Set your token once per shell, then run the checks:

   ```pwsh
   $env:SONAR_TOKEN = "<your-local-token>"   # scanner reads this automatically
   npm run code-check                        # all quality gates + local Sonar scan
   ```

   `sonar-scanner` reads `sonar-project.properties`; `sonar.organization` is a
   Cloud concept and is ignored by the local server. Results appear at
   <http://localhost:9000>.

### npm scripts

| Script | What it runs |
| --- | --- |
| `npm run check` | lint + format check + typecheck + coverage + Rust fmt/clippy/test |
| `npm run sonar:local` | `sonar-scanner` against `http://localhost:9000` (needs `SONAR_TOKEN`) |
| `npm run code-check` | `check` then `sonar:local` — the full pre-push gate |

`code-check` needs the local SonarQube server running and `SONAR_TOKEN` set; to
run only the quality gates without Sonar, use `npm run check`.

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
