# ADR 0008 — End-to-end tests

- Status: accepted
- Date: 2026-10-26
- Phase: 5

## Context

Blueprint §16.3 asks for Playwright tests of the desktop UI "where supported by the chosen
Tauri testing approach". It also asks for no real AI calls in automated tests. The Tauri
window cannot be built on the development machine (no Rust toolchain).

## Decision

`tests/e2e` (package `@aap/e2e`) runs Playwright against **the same static export that Tauri
would load**:

- The UI is served from `apps/desktop/out/` by a small static server that resolves `/a/b` to
  `a/b.html`, as Tauri does.
- The backend is the **compiled** `apps/backend/dist/server.js`, not a dev server.
- The agent is the offline fake (`AAP_CODING_AGENT=fake`). No AI calls, no network.
- **Each test gets its own environment:** a temporary data folder, a temporary workspace
  containing a copy of `examples/sample-app`, and a fresh backend. This is an automatic
  fixture. Tests run one at a time, on fixed ports (backend 41799, UI 3199). The UI build
  inlines the API URL and a fixed test token, so `globalSetup` rebuilds the UI with them.
- **The browser** is Microsoft Edge (`channel: 'msedge'`), which ships with Windows, so no
  browser download is needed. Set `E2E_BROWSER=chromium` elsewhere.
- `Stack.crashBackend()` kills the backend with no chance to clean up, and `startBackend()`
  starts it again on the same data folder. This tests recovery from a real crash.
- `pnpm e2e` builds first. It is separate from `pnpm check`, because it needs a browser.

The suite covers every scenario of §16.3:

| Scenario                                             | Spec                          |
| ---------------------------------------------------- | ----------------------------- |
| Open the app; backend connected; integrations shown  | `app.spec.ts`                 |
| Workflow catalog from the backend                    | `app.spec.ts`                 |
| Start an execution and watch progress                | `demo-workflow.spec.ts`       |
| Approve and reject                                   | `demo-workflow.spec.ts`       |
| Bounded retries visible                              | `demo-workflow.spec.ts`       |
| History and filters, Approvals page                  | `demo-workflow.spec.ts`       |
| Generate Spec: review, approve, file saved           | `generate-spec.spec.ts`       |
| Paths outside the workspace refused, nothing written | `generate-spec.spec.ts`       |
| Cancel a running execution                           | `cancel-and-recovery.spec.ts` |
| History persists across a restart                    | `cancel-and-recovery.spec.ts` |
| Crash during an AI step → INTERRUPTED → Resume       | `cancel-and-recovery.spec.ts` |

## Consequences

- After `pnpm e2e`, `apps/desktop/out/` contains the test token. `pnpm build` (and Tauri's
  `beforeBuildCommand`) rebuilds it without the token.
- Native Tauri behaviour (window, IPC, packaging) is not covered. Once Tauri builds, add a
  WebDriver-based suite (`tauri-driver`) for those parts only. The browser suite stays the
  main one.

## Rejected alternatives

- **Testing against `next dev`.** It is faster to start, but it is not what ships: the dev
  overlay, on-demand compilation and server rendering behave differently from the static
  export.
- **`tauri-driver` / WebDriver now.** It needs a Tauri build, which this machine cannot make.
- **A real Claude call in the suite.** It costs money, needs network and a login, and is not
  deterministic. One real run was verified by hand instead (ADR 0007).
- **One shared backend for all tests.** It is faster, but tests would see each other's
  executions, and the restart tests would affect the others.
