# ai-workflow-automation

**AI Automation Platform**: a local-first desktop app to configure, run, monitor and review
AI-powered development workflows (spec generation, bug fixing, test-script generation and
more). It runs on your machine. There is no remote application backend.

## Status

**Phase 4 (Generate Spec workflow).** What exists today:

- A pnpm monorepo with strict TypeScript, ESLint, Prettier and Vitest.
- `packages/workflow-core`: the workflow contract (`defineWorkflow`), registry, execution
  lifecycle, the in-process worker (`ExecutionEngine`) with cooperative cancellation, human
  approval states, bounded retries, step timeouts, SQLite persistence with migrations, event
  history, conservative restart recovery and manual resume.
- `packages/integrations`: a shell-free process runner (timeouts, cancellation, output caps,
  kills whole process trees), a workspace filesystem limited to allowed folders, and coding
  agents: Claude Code CLI (read-only, restricted) and an offline fake.
- `packages/workflow-generate-spec`: the **Generate Spec** workflow. It reads a source folder,
  drafts a Markdown spec with Claude Code (facts cited, assumptions listed separately), checks
  it, waits for your review, and saves it.
- `packages/workflow-demo`: the `demo-sequence` workflow (no AI, no side effects), with an
  optional review step and simulated failures to try approvals and retries.
- `apps/backend`: a Fastify API bound to `127.0.0.1`, protected by a per-run bearer token,
  Host and Origin checks. It provides the workflow catalog, start, history, detail, events,
  cancel, approval decisions and resume.
- `apps/desktop`: a Next.js (static export) UI with these screens: dashboard, workflow catalog,
  a start form generated from each workflow's input schema, execution history with filters,
  a live execution monitor with approve/reject and resume, and an Approvals page. It also
  holds the Tauri 2 shell configuration.
- `packages/shared`: Zod schemas for the API contracts both apps use.

**Not built yet:** other workflows (Fix Bug, Playwright, Gatling), and the end-to-end test suite. The Tauri shell has **not been compiled yet**, because the development machine
has no Rust toolchain (see Prerequisites); the packaged app does not start the backend yet
either.

## Prerequisites

| Tool                                            | Version | Needed for                                         |
| ----------------------------------------------- | ------- | -------------------------------------------------- |
| Node.js                                         | ≥ 24.11 | everything                                         |
| pnpm                                            | 11.24.0 | everything                                         |
| Rust (via [rustup](https://rustup.rs/))         | ≥ 1.90  | the Tauri desktop shell only                       |
| Visual Studio Build Tools (C++ and Windows SDK) | 2022    | the Tauri shell on Windows only                    |
| WebView2 runtime                                | any     | the Tauri shell on Windows (ships with Windows 11) |

Without Rust, you can still develop the whole UI in a browser with `pnpm dev`.

## Getting started

```sh
pnpm install
pnpm dev            # backend on http://127.0.0.1:41731, UI on http://localhost:3000
pnpm dev:desktop    # the same, inside the Tauri window (needs Rust)
```

In VS Code, the Run and Debug panel has ready-made configurations (`.vscode/launch.json`):
**Demo: full stack** (backend and UI with the debugger attached), **Demo: open UI in Edge**,
the compound **Demo: full stack + Edge**, and **Tests: debug current test file**.

## Commands

| Command              | What it does                                                  |
| -------------------- | ------------------------------------------------------------- |
| `pnpm dev`           | Backend (watch mode) and Next.js dev server                   |
| `pnpm dev:desktop`   | `tauri dev`: starts `pnpm dev` and opens the desktop window   |
| `pnpm build`         | Builds shared, backend (`dist/`) and UI (`apps/desktop/out/`) |
| `pnpm build:desktop` | `tauri build`: desktop installers (needs Rust)                |
| `pnpm typecheck`     | TypeScript checks for every package                           |
| `pnpm lint`          | ESLint with type-aware rules for the whole repo               |
| `pnpm test`          | Vitest suites                                                 |
| `pnpm format`        | Prettier, write mode (`format:check` to verify only)          |
| `pnpm check`         | format check, lint, typecheck, test and build, in order       |

## Backend configuration

Environment variables, validated at startup:

| Variable              | Default                                                          | Notes                                      |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `AAP_HOST`            | `127.0.0.1`                                                      | Only `127.0.0.1` or `::1` are accepted     |
| `AAP_PORT`            | `41731`                                                          | `0` picks a free port                      |
| `AAP_ALLOWED_ORIGINS` | `http://localhost:3000,http://tauri.localhost,tauri://localhost` | CORS allowlist. CORS is not authentication |
| `AAP_LOG_LEVEL`       | `info`                                                           | Pino level, or `silent`                    |
| `AAP_LOG_FORMAT`      | `json`                                                           | `pretty` is set by `pnpm dev`              |
| `AAP_DATA_DIR`        | `<OS app data>/com.aiautomationplatform.desktop/dev`             | Holds `aap.db`. Never inside the repo      |
| `AAP_API_TOKEN`       | none, required                                                   | ≥ 32 chars. `pnpm dev` generates one       |

On Windows the default database is
`%APPDATA%\com.aiautomationplatform.desktop\dev\aap.db`. Delete that folder to start from an
empty history.

The UI reads the backend URL from `NEXT_PUBLIC_AAP_API_URL` (default `http://127.0.0.1:41731`)
and the token from `NEXT_PUBLIC_AAP_API_TOKEN` at build time; `pnpm dev` sets the token. To
call the API by hand, start the backend with your own token:

```sh
AAP_API_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") pnpm --filter @aap/backend dev
curl -H "Authorization: Bearer $AAP_API_TOKEN" http://127.0.0.1:41731/api/workflows
```

The endpoints are listed in [ADR 0005](docs/adr/0005-execution-api-and-local-auth.md).

## Layout

```text
apps/
  backend/          Fastify API (src/api, src/config, src/plugins, src/workers), tests in test/
  desktop/          Next.js UI (src/app, src/features, src/components, src/lib)
    src-tauri/      Tauri 2 shell (Rust)
packages/
  shared/           Zod API contracts shared by backend and UI
  workflow-core/    Engine, contracts, registry, persistence (drizzle/ holds the migrations)
  workflow-demo/    demo-sequence workflow
docs/adr/           Architecture decision records
```

After changing `packages/workflow-core/src/persistence/schema.ts`, generate a migration with
`pnpm --filter @aap/workflow-core db:generate` and commit it. Never edit a committed migration.

## Decisions

- [ADR 0001: Monorepo layout and toolchain versions](docs/adr/0001-monorepo-and-toolchain.md)
- [ADR 0002: Next.js static export inside Tauri](docs/adr/0002-desktop-frontend-static-export.md)
- [ADR 0003: Local backend network boundary](docs/adr/0003-local-backend-network-boundary.md)
- [ADR 0004: Workflow engine and persistence](docs/adr/0004-workflow-engine-and-persistence.md)
- [ADR 0005: Execution API, local auth and cancellation](docs/adr/0005-execution-api-and-local-auth.md)
- [ADR 0006: Approvals, retries, timeouts and recovery](docs/adr/0006-approvals-retries-and-recovery.md)
- [ADR 0007: Integrations and the Generate Spec workflow](docs/adr/0007-integrations-and-generate-spec.md)

## Troubleshooting

- **The UI says "Unavailable".** The backend is not running, or runs on another port. Start it
  with `pnpm dev`, or set `NEXT_PUBLIC_AAP_API_URL` to match `AAP_PORT`.
- **`pnpm dev:desktop` fails with "rustc: not installed".** Install Rust and the Visual Studio
  C++ Build Tools, then run `pnpm tauri info` from `apps/desktop` to check.
- **Dev servers are still running after closing the terminal (Windows).** Find the process with
  `netstat -ano | findstr :41731` and stop the whole tree with `taskkill /PID <pid> /T /F`.
