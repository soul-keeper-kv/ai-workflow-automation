# ai-workflow-automation

**AI Automation Platform**: a local-first desktop app to configure, run, monitor and review
AI-powered development workflows. It runs on your machine; there is no remote application
backend. AI work goes through the Claude Code CLI under your own login.

## What works today

| Area            | Status                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Workflow engine | XState machines, persisted state, approvals, bounded retries, timeouts, cancellation, crash recovery, manual resume |
| Workflows       | **Generate Spec** (Claude Code drafts a spec from source; you review; it is saved), **Demo sequence** (no AI)       |
| API             | Fastify on `127.0.0.1` only, bearer token, Host and Origin checks, Zod-validated                                    |
| UI              | Dashboard, workflow catalog, generated start forms, execution monitor, approvals, history                           |
| Persistence     | SQLite in the OS app-data folder, versioned migrations                                                              |
| Tests           | 202 unit and integration tests; 11 end-to-end tests in Edge against the real backend                                |

### Not built yet, or not verified

- **The Tauri desktop window has never been compiled.** The development machine has no Rust
  toolchain or Visual Studio C++ Build Tools. The UI runs in a browser instead, which is the
  same static export Tauri would load.
- **The packaged app does not start the backend.** In production, Tauri must start the
  backend, generate its token and pass both to the webview. That is designed (ADR 0003,
  ADR 0005) but not built, because it cannot be compiled here.
- Tauri's content security policy is still `null` (ADR 0002).
- Fix Bug, Playwright and Gatling workflows are not built. Editing workflows will need a write
  mode in an isolated Git worktree (ADR 0007).

## Prerequisites

| Tool                                            | Version             | Needed for                                                            |
| ----------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| Node.js                                         | ≥ 24.11             | everything                                                            |
| pnpm                                            | 11.24.0             | everything (`corepack enable` or `npm i -g pnpm@11.24.0`)             |
| Claude Code CLI                                 | tested with 2.1.296 | the Generate Spec workflow with real AI (`claude` on PATH, logged in) |
| Microsoft Edge or Chromium                      | any recent          | end-to-end tests                                                      |
| Rust (via [rustup](https://rustup.rs/))         | ≥ 1.90              | the Tauri desktop window only                                         |
| Visual Studio Build Tools (C++ and Windows SDK) | 2022                | the Tauri window on Windows only                                      |

## Install and run

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:3000>.

`pnpm dev` starts the backend (`http://127.0.0.1:41731`) and the UI together. It also:

- generates a fresh API token for that run;
- allows `examples/` as the only workspace folder, unless you set `AAP_WORKSPACE_ROOTS`.

To work offline, without AI, use the fake agent:

```sh
AAP_CODING_AGENT=fake pnpm dev        # bash
$env:AAP_CODING_AGENT='fake'; pnpm dev # PowerShell
```

**In VS Code**, use the Run and Debug panel (`.vscode/launch.json`):

- **Demo: full stack**: backend and UI, with breakpoints in both;
- **Demo: open UI in Edge** (or Chrome);
- **Demo: full stack + Edge**: both together;
- **Tests: debug current test file**.

## Try it

1. **Demo sequence.** Workflows → Demo sequence → Start.
   - Leave _Ask for review_ on to try approvals.
   - Set _Simulated failures_ to 1 or 2 to watch the retries.
   - While it runs, you can cancel it from the execution page.
2. **Generate Spec.** Workflows → Generate spec → Start, with:
   - Source directory: `<repo>\examples\sample-app`
   - Output directory: `<repo>\examples\specs`

   Claude Code reads the files (read-only) and drafts a spec. You review it under
   **Approvals**, and the approved spec is saved in the output directory. With the real CLI,
   a run on the sample app took about 50 s and cost about USD 0.15. Set
   `AAP_CLAUDE_MAX_BUDGET_USD` to cap it.

3. **Recovery.** Stop the backend while Generate Spec is drafting, then start it again. The
   execution shows **Interrupted** with a Resume button: the AI step is never re-run without
   asking you.

The dashboard's **Integrations** card shows the AI integration, where your code goes, and
which folders workflows may touch.

## Configuration

Backend environment variables, validated at startup:

| Variable                           | Default                                                          | Notes                                                     |
| ---------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| `AAP_API_TOKEN`                    | none, required                                                   | ≥ 32 characters. `pnpm dev` generates one                 |
| `AAP_WORKSPACE_ROOTS`              | none (`pnpm dev`: `examples/`)                                   | Folders workflows may read and write, separated like PATH |
| `AAP_CODING_AGENT`                 | `claude-code`                                                    | `fake` for offline use and tests                          |
| `AAP_CLAUDE_EXECUTABLE`            | `claude` on PATH                                                 | Path to the CLI, if it is not on PATH                     |
| `AAP_CLAUDE_MODEL`                 | CLI default                                                      | Passed as `--model`                                       |
| `AAP_CLAUDE_MAX_BUDGET_USD`        | none                                                             | Passed as `--max-budget-usd`                              |
| `AAP_FAKE_AGENT_DELAY_MS`          | `1500`                                                           | How long the fake agent pretends to work                  |
| `AAP_DATA_DIR`                     | `<OS app data>/com.aiautomationplatform.desktop/dev`             | Holds `aap.db`. Never inside the repo                     |
| `AAP_HOST`                         | `127.0.0.1`                                                      | Only `127.0.0.1` or `::1` are accepted                    |
| `AAP_PORT`                         | `41731`                                                          | `0` picks a free port                                     |
| `AAP_ALLOWED_ORIGINS`              | `http://localhost:3000,http://tauri.localhost,tauri://localhost` | CORS allowlist; not authentication                        |
| `AAP_LOG_LEVEL` / `AAP_LOG_FORMAT` | `info` / `json`                                                  | `pnpm dev` uses `pretty`                                  |

The UI reads `NEXT_PUBLIC_AAP_API_URL` and `NEXT_PUBLIC_AAP_API_TOKEN` at build time; `pnpm dev`
sets them. To call the API yourself:

```sh
curl -H "Authorization: Bearer <token>" http://127.0.0.1:41731/api/workflows
```

## Commands

| Command                                   | What it does                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`                                | Backend (watch mode) and UI, with a fresh token                                   |
| `pnpm build`                              | Builds every package, the backend (`dist/`) and the UI (`apps/desktop/out/`)      |
| `pnpm check`                              | Format check, lint, typecheck, unit and integration tests, build                  |
| `pnpm test`                               | Unit and integration tests (Vitest)                                               |
| `pnpm e2e`                                | Builds, then runs the end-to-end suite in Edge (`E2E_BROWSER=chromium` elsewhere) |
| `pnpm dev:desktop` / `pnpm build:desktop` | Tauri window / installers (need Rust)                                             |

`pnpm e2e` rebuilds `apps/desktop/out/` with a test token inlined. Run `pnpm build` afterwards
before packaging.

## Layout

```text
apps/
  backend/                 Fastify API, runtime wiring (src/workers), tests in test/
  desktop/                 Next.js UI (static export) and the Tauri shell (src-tauri/)
packages/
  shared/                  Zod API contracts used by both apps
  workflow-core/           Engine, contracts, registry, persistence; drizzle/ holds migrations
  integrations/            Process runner, workspace filesystem, coding agents
  workflow-generate-spec/  Generate Spec workflow
  workflow-demo/           Demo sequence workflow
tests/e2e/                 Playwright end-to-end tests
examples/                  Sample input for workflows
docs/                      ADRs, security notes, how to add a workflow
```

## Troubleshooting

| Symptom                                                   | Fix                                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI shows **Unavailable** for the backend                  | The backend is not running, or it runs on another port. Start everything with `pnpm dev`.                                                                   |
| "The UI has no valid API token"                           | The UI was not started by `pnpm dev`, or was built without the token. Restart with `pnpm dev`.                                                              |
| Generate Spec says **Claude Code CLI not found**          | Install the CLI and make sure `claude --version` works in a new terminal, or set `AAP_CLAUDE_EXECUTABLE`. Then restart: the CLI is checked once at startup. |
| `PATH_NOT_ALLOWED`                                        | The source or output path is outside `AAP_WORKSPACE_ROOTS`. Use a folder inside the allowed list shown on the dashboard.                                    |
| `AGENT_FAILED` or `AGENT_RATE_LIMITED`                    | Run `claude -p "hi"` in a terminal to check your login and network. Rate limits are retried once automatically.                                             |
| An execution is **Interrupted**                           | The app stopped while a step that may have side effects was running. Check its output, then Resume (it re-runs the step) or Cancel.                         |
| Servers keep running after closing the terminal (Windows) | `netstat -ano \| findstr :41731`, then `taskkill /PID <pid> /T /F`.                                                                                         |
| Start from an empty history                               | Stop the backend and delete `%APPDATA%\com.aiautomationplatform.desktop\dev\`.                                                                              |
| `pnpm e2e` cannot find a browser                          | Install Edge, or run `pnpm --filter @aap/e2e exec playwright install chromium` and set `E2E_BROWSER=chromium`.                                              |
| Port 41731 or 3000 is in use                              | Set `AAP_PORT` and `NEXT_PUBLIC_AAP_API_URL`, or stop the other process.                                                                                    |

## Further reading

- [How to add a workflow](docs/adding-a-workflow.md)
- [Security controls](docs/security.md)
- Decisions:
  - [0001 Toolchain](docs/adr/0001-monorepo-and-toolchain.md)
  - [0002 Static export in Tauri](docs/adr/0002-desktop-frontend-static-export.md)
  - [0003 Network boundary](docs/adr/0003-local-backend-network-boundary.md)
  - [0004 Engine and persistence](docs/adr/0004-workflow-engine-and-persistence.md)
  - [0005 API and local auth](docs/adr/0005-execution-api-and-local-auth.md)
  - [0006 Approvals, retries and recovery](docs/adr/0006-approvals-retries-and-recovery.md)
  - [0007 Integrations and Generate Spec](docs/adr/0007-integrations-and-generate-spec.md)
  - [0008 End-to-end tests](docs/adr/0008-end-to-end-tests.md)
