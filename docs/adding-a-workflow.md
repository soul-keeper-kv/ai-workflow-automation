# Adding a workflow

A workflow is a package that exports a `Workflow` made with `defineWorkflow`. The engine, API
and UI need no changes: the catalog, the start form, progress, approvals and history come from
the definition. Use `packages/workflow-demo` (small) and `packages/workflow-generate-spec`
(integrations, approvals, retries) as references.

## 1. Create the package

Copy `packages/workflow-demo` to `packages/workflow-<name>`, then:

- rename the package to `@aap/workflow-<name>`;
- keep the `build`, `typecheck` and `test` scripts;
- depend on `@aap/workflow-core`, `xstate` and `zod`, plus `@aap/integrations` if it needs
  files or an agent.

## 2. Define input, context and output with Zod

- **`inputSchema`** is what the person fills in. It is published as JSON Schema and turned
  into the start form. Use `.meta({ title, description })` for labels and help text.
  Supported controls: text, number, boolean, enum and string lists; anything else becomes a
  JSON field.
- **`contextSchema`** is everything the machine remembers. It is validated each time it is
  saved and read, and must survive JSON: no `Date`, no `Map`.
- **`outputSchema`** is the result of a COMPLETED run.

## 3. Write a flat, pure machine

```ts
const machine = setup({
  types: { context: {} as Context, events: {} as Event, input: {} as Input, output: {} as Output },
  guards: { ready: ({ context }) => context.items.length > 0 },
}).createMachine({
  initial: 'COLLECT',
  context: ({ input }) => ({ ... }),
  states: {
    COLLECT: { on: { COLLECTED: { target: 'REVIEW', actions: assign({ ... }) } } },
    REVIEW: { on: { APPROVED: 'APPLY', REJECTED: 'REJECTED' } },
    APPLY: { on: { APPLIED: 'DONE' } },
    DONE: { type: 'final' },
    REJECTED: { type: 'final' },
  },
  output: ({ context }) => ({ ... }),
});
```

- **Flat:** top-level states only.
- **Pure:** guards and `assign` only, with no `invoke`, delays or custom actions.
  `defineWorkflow` rejects anything else.
- Include `ApprovalDecisionEvent` in your events if you have an approval state.

## 4. Describe each state

```ts
states: {
  COLLECT: {
    kind: 'step',
    title: 'Collect items',
    recovery: 'rerun',            // safe to repeat after a crash? default 'manual'
    timeoutMs: 60_000,
    retry: { maxAttempts: 3, initialDelayMs: 1_000 }, // only for StepError({ retryable: true })
    run: async ({ context, signal, log, attempt }): Promise<Event> => ({ type: 'COLLECTED', ... }),
  },
  REVIEW: {
    kind: 'approval',
    title: 'Review',
    approvalType: 'items-review',
    request: (context) => ({ summary: ..., note: 'What the reviewer should check' }),
  },
  ...
  DONE: { kind: 'final', title: 'Done', status: 'COMPLETED' },
  REJECTED: { kind: 'final', title: 'Rejected', status: 'CANCELLED' },
}
```

Rules for steps:

- **Return an event; let the machine decide where it leads.** Annotate inline async steps
  with `Promise<Event>`, or TypeScript widens the event type to `string`.
- **Honour `signal`.** It aborts on cancel, timeout and shutdown. Pass it to every process,
  agent call and `sleep`.
- **Throw `StepError`** with a stable `code`. Set `retryable: true` only for failures that a
  later attempt can fix.
- **Mark `recovery: 'rerun'` only if repeating the step is harmless.** Editing files is not
  harmless unless the edit is idempotent.
- **Get integrations by injection.** Export a factory, as
  `createGenerateSpecWorkflow({ filesystem, codingAgent })` does, never a module-level
  client. Tests pass fakes.

## 5. Register it

Add it to `apps/backend/src/workers/registered-workflows.ts`, with its `requirements`
(`workspace`, `coding-agent`) and an `availability()` check. Registration is an explicit list;
nothing is loaded dynamically.

## 6. Test it

- **Unit tests in the package.** Use an in-memory database (`openWorkflowDatabase(':memory:')`),
  `ExecutionEngine`, and `FakeCodingAgent` or a temporary `WorkspaceFilesystem`. Cover the
  happy path, every failure code, rejection, cancel and recovery.
- **An e2e test in `tests/e2e/specs`** if the workflow adds UI behaviour.

## Versioning

Bump `version` whenever the machine or the context shape changes. An unfinished execution of an
older version becomes INTERRUPTED (`WORKFLOW_UNAVAILABLE`) instead of resuming on a machine it
was not written for.
