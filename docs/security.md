# Security controls

What protects the user's machine and code today, where each control lives, and how it is
tested. Gaps are listed at the end. For the reasoning behind each choice, see the linked ADRs.

## Local API (blueprint §15.1, ADR 0003, ADR 0005)

| Control                                                                                                | Where                                        | Tested by                          |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------- |
| Binds to `127.0.0.1` or `::1` only; any other host is a startup error                                  | `apps/backend/src/config/env.ts`             | `config.test.ts`                   |
| `Host` must be a loopback name (DNS-rebinding guard)                                                   | `plugins/security.ts`                        | `api.test.ts`                      |
| A request with an `Origin` outside the allowlist gets 403                                              | `plugins/security.ts`                        | `api.test.ts`                      |
| Bearer token on every route except `/health`, decided by the matched route; unknown routes need it too | `plugins/security.ts`                        | `api.test.ts` (incl. `/%61pi/...`) |
| Token compared in constant time (SHA-256 + `timingSafeEqual`)                                          | `plugins/security.ts`                        | —                                  |
| Errors in one envelope; 5xx responses hide internal messages and stacks                                | `plugins/error-handler.ts`                   | `app.test.ts`                      |
| Only route patterns are logged, never raw URLs or query strings; auth headers are redacted             | `app.ts`                                     | `logging.test.ts`                  |
| Request bodies and every JSON column are size-limited                                                  | Fastify default, `sqlite-execution-store.ts` | store tests                        |

## Files (blueprint §15.3, ADR 0007)

| Control                                                                         | Where                 | Tested by                      |
| ------------------------------------------------------------------------------- | --------------------- | ------------------------------ |
| Workflows touch only `AAP_WORKSPACE_ROOTS`                                      | `WorkspaceFilesystem` | `workspace-filesystem.test.ts` |
| Paths are resolved through symlinks before the check; `..` traversal is refused | `WorkspaceFilesystem` | same, incl. a junction escape  |
| Discovery never follows links, and skips VCS, dependency and build folders      | `listFiles`           | same                           |
| Writes are atomic, take plain names only, and refuse dotfiles                   | `writeTextFile`       | same                           |
| Generate Spec checks paths before any AI call                                   | `VALIDATE_INPUT` step | `generate-spec.test.ts`, e2e   |

## AI agent and processes (blueprint §10, ADR 0007)

| Control                                                                                                                                                 | Where                   | Tested by                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| No shell: explicit executable and argument array                                                                                                        | `runProcess`            | `run-process.test.ts` (shell metacharacters stay literal) |
| Timeout, cancellation, output caps; the **whole process tree** is killed                                                                                | `runProcess`            | same (grandchild killed on Windows)                       |
| Claude Code runs read-only and restricted: `--tools Read,Grep,Glob --restricted --permission-prompts none --strict-mcp-config --no-session-persistence` | `ClaudeCodeAgent`       | `coding-agents.test.ts`                                   |
| The prompt goes over stdin; `AAP_*` (the API token), `NEXT_PUBLIC_*` and nested-session variables never reach the CLI                                   | `ClaudeCodeAgent`       | same                                                      |
| The configured agent and where code goes are shown before a run                                                                                         | `/api/integrations`, UI | e2e `app.spec.ts`, `generate-spec.spec.ts`                |
| AI output is checked automatically, then reviewed by a person before it is saved                                                                        | Generate Spec           | unit and e2e                                              |
| A cost cap is available (`AAP_CLAUDE_MAX_BUDGET_USD`)                                                                                                   | config                  | —                                                         |

## Execution safety (blueprint §9, ADR 0004, ADR 0006)

- Steps that may have side effects are never re-run blindly after a crash. They become
  INTERRUPTED, and only a person can resume them (e2e `cancel-and-recovery.spec.ts`).
- Only errors marked retryable are retried, within a bounded budget.
- An approval event is accepted only for the pending approval of a waiting execution.
- Lifecycle moves outside the allowed table, and writes with a stale revision, are rejected
  inside the transaction.

## Known gaps

- **The development UI bundle contains the API token** (ADR 0005). Other web pages cannot use
  it: Origin is checked and CORS blocks reading responses. The packaged app must take the
  token from Tauri at runtime. That is not built yet.
- **Tauri CSP is `null`** until a Tauri build can be tested.
- **Prompt injection.** Source files can contain instructions to the agent. Its tools are
  read-only and confined to the source folder, and a person reviews the output, but the
  draft itself can be misled. Reviewers should check claims against the cited files.
- **Data leaves the machine** when the Claude Code agent runs: the prompt and the files it
  reads go to Anthropic under the user's login. Company policy decides whether that is allowed
  for a given codebase. The app states it, but cannot enforce it.
- No secret store is used yet: the app manages no credentials of its own, and the Claude CLI
  keeps its own login.
