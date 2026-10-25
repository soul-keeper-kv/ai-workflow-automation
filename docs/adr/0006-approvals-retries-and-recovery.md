# ADR 0006 — Approvals, bounded retries, timeouts and recovery policy

- Status: accepted
- Date: 2026-10-26
- Phase: 3

## Context

Phase 3 of the blueprint requires:

- human approval that a workflow cannot get past without a valid decision (§7.3);
- bounded, explicit retries that skip validation and permission failures (§9.4);
- step timeouts;
- conservative recovery that never blindly repeats unsafe work (§9.3).

## Decision

### Approval states

A workflow state can be `kind: 'approval'`, with an `approvalType` and a
`request(context)` function. The request must be JSON: what the reviewer sees. The machine
state must handle both `APPROVED` and `REJECTED` (`ApprovalDecisionEvent`, which carries
`feedback`); `defineWorkflow` rejects it otherwise.

**Waiting.** When a step's transition lands in an approval state, the same transaction:

- sets the status to WAITING_FOR_APPROVAL;
- creates a PENDING row in `workflow_approvals`;
- records `APPROVAL_REQUESTED`.

The run loop then ends. Nothing runs while an execution waits, and recovery leaves waiting
executions alone.

**Deciding.** `engine.decide(executionId, approvalId, decision, feedback)` is applied only
when the execution is WAITING_FOR_APPROVAL and the approval is the PENDING one for its
current state. The decision is sent to the machine, which must accept the event. Then one
transaction:

- marks the approval APPROVED or REJECTED, with `{ decision, feedback }`;
- applies the transition;
- records `APPROVAL_DECIDED` and `STATE_CHANGED`.

The execution then continues (RUNNING), ends (final state), or waits again (another approval
state). A second decision, an unknown approval, or a decision while the execution is not
waiting is rejected (409 or 404).

**Invariants in the store.**

- A partial unique index allows at most one PENDING approval per execution.
- Leaving WAITING_FOR_APPROVAL without a decision (cancel, failure) closes the pending request
  as CANCELLED.
- The lifecycle table gains `WAITING_FOR_APPROVAL → COMPLETED`, because an approval may lead
  straight to a final state. A test found this gap.

### Retries and timeouts

Steps (and a workflow-wide `policy` default) declare:

- `retry`: `maxAttempts` (1 to 10), `initialDelayMs`, `multiplier`, `maxDelayMs`, and
  `retryOnTimeout`;
- `timeoutMs`;
- `recovery`.

- **What is retried.** Only errors that say so: `StepError` with `retryable: true`, or a
  timeout when `retryOnTimeout` is set. Plain errors, contract errors (`INVALID_TRANSITION`,
  `INVALID_CONTEXT`) and anything not marked retryable fail immediately.
- **The budget.** It counts consecutive FAILED attempts of the current step, read from the
  database, so a restart during the backoff neither resets nor overruns it. Every failed
  attempt is kept as its own step run, followed by a `STEP_RETRY_SCHEDULED` event.
- **The backoff.** The wait is aborted by cancel or shutdown. A shutdown during the backoff
  leaves the execution between steps, so it resumes on the next start.
- **Timeout.** The step's signal is aborted with `StepTimeoutError`. If the step still has not
  settled after a grace period (5 s), the engine abandons it and records `STEP_TIMEOUT` with
  "may still be running". Such a timeout is never retried, because the abandoned attempt
  could still be making changes.

### Recovery and resume

- `recovery: 'rerun'` marks a step as safe to repeat. If the app died while it ran, startup
  closes the stale attempt as INTERRUPTED and runs the step again. The default, `manual`,
  keeps the Phase 1 behaviour: the execution becomes INTERRUPTED.
- `engine.resume()` (`POST /api/executions/:id/resume`) lets a person re-run the current
  step of an INTERRUPTED execution. The UI explains that side effects may repeat and asks
  for confirmation.

### Demo and UI

- `demo-sequence` 2.0.0 shows each mechanism:
  - an optional review step, selected by a guard;
  - simulated retryable failures with three attempts;
  - steps marked `rerun`, because they are pure.
- The execution monitor shows:
  - an approval panel with the request rendered as text and JSON, never HTML, optional
    feedback, and Approve and Reject;
  - approval history;
  - a resume panel for INTERRUPTED executions.
- The new Approvals page lists every waiting execution.
- New events: `APPROVAL_REQUESTED`, `APPROVAL_DECIDED`, `STEP_RETRY_SCHEDULED` and
  `EXECUTION_RESUMED`. Migration 0002 adds `workflow_approvals`.

## Consequences

- Executions of `demo-sequence` 1.0.0 that are not finished become INTERRUPTED with
  `WORKFLOW_UNAVAILABLE`, because the version changed. Finished ones are unaffected.
- Steps that start child processes must stop them when their signal aborts. Otherwise a
  timeout abandons them, and cancellation waits for them.
- A FAILED execution stays failed. Re-running it means starting a new execution: a failed
  run's history is evidence and is kept unchanged.

## Rejected alternatives

- **Retrying every error by default.** It repeats validation, permission and contract errors
  that will never succeed, and it can repeat side effects.
- **Retries as machine states (an explicit RETRY state per step).** Every workflow would
  rewrite the same loop. The engine already owns attempts, so a declarative policy is
  enough.
- **Approval as a special step that polls the database.** That keeps a run loop and a timer
  alive for as long as a person takes, possibly days. A waiting status with no loop costs
  nothing and survives restarts trivially.
- **Allowing FAILED → RUNNING (retrying a failed execution in place).** It blurs the history
  of what failed. Starting a new execution is clearer.
