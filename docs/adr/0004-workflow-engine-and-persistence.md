# ADR 0004 — Workflow engine: pure machines, engine-run steps, SQLite persistence

- Status: accepted
- Date: 2026-10-26
- Phase: 1

## Context

The blueprint asks for XState-based workflows with durable execution, and warns that XState
"is the state machine library, not the entire persistence or recovery solution" (§2.3).
Recovery must never blindly re-run a step that may have had side effects (§9.3).

## Decision

### Machines decide, the engine does the work

A workflow is a **pure, flat** XState machine plus one definition per state
(`packages/workflow-core/src/contracts/workflow.ts`):

- A **step** state has a `run()` function. The engine calls it and the step returns an
  **event**. The machine decides, through its transitions and guards, where that event leads.
- A **final** state names the execution status it ends in: `COMPLETED`, `CANCELLED` or
  `FAILED`.

`defineWorkflow()` rejects at load time: nested or parallel states, `invoke`, delayed
transitions, a machine state without a definition (or the reverse), and an initial state that
is not a step. At run time, a machine that asks for any action other than `assign` fails with
`UNSUPPORTED_MACHINE_ACTION`, because the engine never runs such actions.

The engine uses XState's pure functions: `initialTransition`, `machine.resolveState`,
`snapshot.can(event)` and `transition`. No long-lived actors exist. An event that the current
state does not accept is rejected (`INVALID_TRANSITION`) instead of being silently ignored.

### What is persisted

Each execution stores `current_state` (a string, because machines are flat) and
`context_json`. The context is validated with the workflow's `contextSchema` every time it is
written, after a JSON round trip, and every time it is read back.

The lifecycle (`status`: PENDING, RUNNING, WAITING_FOR_APPROVAL, INTERRUPTED, FAILED,
CANCELLED, COMPLETED) is a separate column from `current_state`. Its allowed moves are one
table (`execution/status.ts`).

### One write path

`ExecutionStore.applyChange()` is the only way to change an execution. One call is one SQLite
transaction (`BEGIN IMMEDIATE`) that can:

- update the execution row,
- start or finish one step run,
- append events.

Inside that transaction it:

- rejects a stale `revision` (optimistic concurrency, for the cancel and approve paths of later
  phases);
- rejects a lifecycle move that is not in the table;
- records `STATUS_CHANGED` itself;
- sets `started_at` and `completed_at`.

A partial unique index allows at most one RUNNING step per execution. JSON columns are capped
(1 MiB for data, 64 KiB per event payload) and error messages are truncated to 2,000
characters.

### Running and recovery

`ExecutionEngine` (the worker) runs in the API process. For each execution, one step at a
time, it:

1. persists the step start;
2. runs the step;
3. persists the step result and the transition together.

Executions run at most two at a time by default; the rest wait in a FIFO queue.

- **Graceful stop.** No new steps start. Running steps get 5 s to finish and commit normally.
  After that they are aborted (`AbortSignal`), and an aborted step leaves its execution
  INTERRUPTED.
- **Startup recovery** (`recovery/plan-recovery.ts`). PENDING or RUNNING with no step
  running means the execution stopped exactly between steps, so it resumes. A step still
  marked RUNNING means the process died mid-step, so the step is marked INTERRUPTED and the
  execution too, and it is not re-run. An execution whose workflow version is no longer
  registered becomes INTERRUPTED with `WORKFLOW_UNAVAILABLE`.

### Where things live

- `packages/workflow-core` owns the execution schema, its migrations (`drizzle/` inside the
  package) and `openWorkflowDatabase()`, which applies them on open.
- The backend picks the file location. `AAP_DATA_DIR` sets it; the default is
  `<OS app data>/com.aiautomationplatform.desktop/dev`. The desktop app will pass its own data
  directory in production.
- The registry is built from an explicit list (`apps/backend/src/workers/registered-workflows.ts`).
- `@aap/workflow-demo` (`demo-sequence`) is the first registered workflow. It has no side
  effects.

## Consequences

- Workflow authors cannot use XState features that need a running actor (invoke, delays,
  spawned children). All work and waiting happen in steps, or in approval states (Phase 3).
- Inline `async` steps need an explicit `Promise<Event>` return type, because TypeScript
  widens event literals otherwise. The contract documents this.
- A context that does not survive JSON (Date, Map) fails when it is written, not after a
  restart.
- Upgrading XState cannot corrupt saved executions, because XState's internal snapshot format
  is never stored.
- Not yet built: approvals and their table (Phase 3), retries and timeouts (Phase 3),
  cancellation (Phase 2), per-step "safe to re-run" recovery (Phase 3), and step capabilities
  such as the filesystem or coding agent (Phase 4).

## Rejected alternatives

- **Steps as XState `invoke` actors with persisted actor snapshots.** Restoring such a snapshot
  restarts the invoked promise: exactly the blind re-run §9.3 forbids. It also ties saved data
  to XState's internal snapshot format.
- **The SQLite store in `apps/backend`.** Core tests would then need an in-memory copy of the
  store, with the same transaction, revision and lifecycle rules written twice.
- **Migrations in a root `drizzle/` folder** (as sketched in the blueprint). Migrations must
  ship with the package that owns the schema and applies them.
- **An async store interface.** better-sqlite3 is synchronous, and its transactions must be
  synchronous functions. An async interface would only add awaits.
- **Storing step input (`input_json`).** The step's input is the execution context, which is
  already stored. Copying it per attempt multiplies storage for no new information.
- **Discovering workflows dynamically** (scanning folders, loading modules by name). It is not
  deterministic, and it is one step away from running code the app did not ship.
