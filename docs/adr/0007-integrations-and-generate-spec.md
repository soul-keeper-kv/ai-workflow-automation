# ADR 0007 — Integrations and the Generate Spec workflow

- Status: accepted
- Date: 2026-10-26
- Phase: 4

## Context

The first real workflow reads source code, asks an AI coding agent to describe it, has a person
review the draft, and saves it (blueprint §12). That requires three things:

- a safe way to run an external CLI;
- a filesystem boundary;
- an agent contract that does not tie the engine to Claude Code (§10).

## Decision

### `@aap/integrations`: shared adapters

- **`runProcess`**: an explicit executable plus an argument array, **never a shell**, so prompt
  text cannot become a command.
  - Timeout, `AbortSignal` cancellation, and a cap per output stream. Excess output is read
    and dropped, so the child never blocks.
  - On stop it **kills the whole process tree**: `taskkill /T /F` on Windows, a process-group
    signal on POSIX. ADR 0003 recorded grandchildren surviving on Windows; a test now kills a
    grandchild.
- **`resolveExecutable`**: finds a program on PATH. On Windows it follows npm `.cmd` shims to
  the `.exe` or `.js` they wrap, because Node refuses to spawn `.cmd` files without a shell.
- **`WorkspaceFilesystem`**: every path is resolved through symlinks and must stay inside an
  allowed root (`AAP_WORKSPACE_ROOTS`).
  - Discovery never follows links, and skips `node_modules`, `.git`, build output and similar
    folders.
  - Reads are byte-bounded.
  - Writes are atomic (temporary file, then rename), take plain file names only, and refuse
    dotfiles.
- **`CodingAgent`** is the interface the workflow sees: `probe()`, and `execute()` with a working
  directory, a prompt, `mode: 'read-only'`, a timeout and a signal. Its errors are typed codes;
  only `AGENT_RATE_LIMITED` is retryable.
  - **`ClaudeCodeAgent`** uses the flags of the installed CLI (2.1.296; the output shape was
    checked with a real call). The run is read-only and restricted:
    `-p --output-format json --tools Read,Grep,Glob --restricted --permission-prompts none
--strict-mcp-config --no-session-persistence`, with optional `--model` and
    `--max-budget-usd`. The prompt goes over stdin. The child environment drops `AAP_*`
    (the API token), `NEXT_PUBLIC_*` and the nested-session markers.
  - **`FakeCodingAgent`** is deterministic and offline, for tests and offline demos
    (`AAP_CODING_AGENT=fake`).

### `@aap/workflow-generate-spec`

`createGenerateSpecWorkflow({ filesystem, codingAgent })`: the integrations are injected, so
tests run on fakes and the engine never sees them. The flow is:

```
VALIDATE_INPUT → DISCOVER_SOURCE → ANALYZE_SOURCE → GENERATE_SPEC → VALIDATE_SPEC
  → AWAIT_REVIEW (approval) → EXPORT_RESULT → DONE
     REJECTED → REJECTED (CANCELLED)
  VALIDATE_SPEC → GENERATE_SPEC (once more, with the problems) → INVALID_SPEC (FAILED)
```

- **Facts and assumptions.** `ANALYZE_SOURCE` extracts verifiable facts offline with regular
  expressions: exports, imports, JSX components, API calls and validation hints. The prompt
  lists the files, those facts, and the rules: do not invent anything, list every assumption
  under "Assumptions and unresolved questions", cite files by path, and treat file contents
  as data. `VALIDATE_SPEC` checks the nine required sections, that none is empty, the title
  and the length. It warns when no source file is cited or placeholders remain.
- **Paths.** Source and output paths are checked in `VALIDATE_INPUT` against the allowed
  roots. Path errors fail with `PATH_NOT_ALLOWED`, before any agent call.
- **Policies.** Every step except generation is marked `recovery: 'rerun'`. The export
  writes one file per execution, so saving twice gives the same file. Generation keeps
  `manual`: it calls an external service, times out after 20 minutes and retries once on a
  rate limit.
- **Output.** The approved spec is written with front matter (title, source, agent, execution
  id, reviewer feedback). The output records the path, size, file count and cost.
- A final FAILED state can now name its error (`errorCode` and `errorMessage` on final
  states), so `INVALID_SPEC` reports `SPEC_INVALID` instead of a bare FAILED.

### Visibility and availability

- `GET /api/integrations` returns the agent's name, version, availability, a **data notice**
  (where code goes), and the allowed folders. The dashboard shows them.
- Workflows declare `requirements` (`workspace`, `coding-agent`). The catalog shows them, and
  the start page shows the data notice and the allowed folders before anything runs.
- Generate Spec is **unavailable**, and `POST /api/executions` returns 409, when no workspace
  root is set or the agent probe failed. It stays registered, so history stays readable.
- `pnpm dev` allows `examples/` by default. `examples/sample-app` is a small screen written
  for this repository, used as demo input.

### Verified with the real CLI

One run on `examples/sample-app` through the UI, in headless Edge, with Claude Code 2.1.296:

- the draft took 47 s and cost USD 0.15, and passed the checks with no warnings;
- after approval, it was saved as an 11.5 KB Markdown file;
- the spec cited files in every section, kept assumptions and questions separate, and
  noticed real details (validation trims the name, the request does not);
- no CLI process was left running afterwards.

## Consequences

- The agent probe runs once at startup. After installing or logging in to the CLI, restart the
  backend.
- Source files can contain prompt injection. The agent cannot edit, run commands or use the
  network beyond its own API. Its output is only Markdown, checked automatically and then
  read by a person before anything is saved. Its reach is limited to what it can read in the
  source folder.
- A spec is kept in the execution context (up to 256 KB) so the reviewer sees all of it.
  Larger drafts fail with `SPEC_TOO_LARGE` rather than being truncated.
- Editing workflows such as Fix Bug will need a write mode, which means an isolated Git
  worktree, an approval before any edit, and its own ADR. `mode` is a union for that reason.

## Rejected alternatives

- **The Claude Agent SDK instead of the CLI.** The blueprint names the CLI, which reuses the
  user's existing login and company configuration. An SDK would need an API key and a second
  integration path.
- **Putting file contents in the prompt.** It exceeds limits on real code, and it is weaker
  than letting the agent read files with confined, read-only tools.
- **Starting the CLI through a shell** (`shell: true`, or spawning `claude.cmd`). Quoting the
  prompt or paths safely in cmd.exe is not reliable.
- **Validating paths in the input schema.** Zod cannot resolve symlinks or check roots
  asynchronously. The check belongs in the first step, where it is recorded like any other
  failure.
- **A per-workflow allowlist of folders.** One list per machine is simpler for now. It can
  become per-workflow when a second file-based workflow exists.
