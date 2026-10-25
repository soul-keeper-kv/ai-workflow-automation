import type { ExecutionStatus } from '@aap/shared';
import {
  initialTransition,
  transition,
  type AnyStateMachine,
  type ContextFrom,
  type EventFromLogic,
  type InputFrom,
  type OutputFrom,
} from 'xstate';
import { z } from 'zod';
import {
  ENGINE_ERROR_CODES,
  InputValidationError,
  WorkflowDefinitionError,
  WorkflowEngineError,
} from './errors.js';
import { jsonRoundTrip, type JsonObject, type JsonValue } from './json.js';
import type { Logger } from './logger.js';

export type FinalStatus = Extract<ExecutionStatus, 'COMPLETED' | 'CANCELLED' | 'FAILED'>;

/** The events the engine sends to an approval state. Include them in your machine's events. */
export type ApprovalDecisionEvent =
  { type: 'APPROVED'; feedback: string | null } | { type: 'REJECTED'; feedback: string | null };

export type ApprovalDecision = ApprovalDecisionEvent['type'];

export interface StepRunContext<TContext> {
  readonly executionId: string;
  /** Name of the machine state this step belongs to. */
  readonly stepId: string;
  /** 1 on the first run of this step in this execution. */
  readonly attempt: number;
  readonly context: TContext;
  /**
   * Aborted on shutdown, cancellation or timeout (see `signal.reason`). Long-running steps
   * must honour it, and must stop child processes they started.
   */
  readonly signal: AbortSignal;
  readonly log: Logger;
}

/**
 * Bounded retries. Only errors that say they are retryable are retried: a StepError created
 * with `retryable: true`, or a timeout when `retryOnTimeout` is set. Validation, contract and
 * permission errors are never retried.
 */
export interface RetryPolicy {
  /** Total attempts, including the first. 1 means no retry. */
  maxAttempts: number;
  /** Delay before the first retry; each further retry multiplies it. */
  initialDelayMs: number;
  multiplier?: number;
  maxDelayMs?: number;
  retryOnTimeout?: boolean;
}

/**
 * What to do when the app restarts and finds this step was running.
 * - `manual` (default): the step may have had side effects; the execution is INTERRUPTED
 *   and a person decides.
 * - `rerun`: the step is safe to repeat (no side effects, or idempotent), so it runs again.
 */
export type RecoveryPolicy = 'manual' | 'rerun';

export interface StepPolicy {
  /** The step is aborted after this long. */
  timeoutMs?: number;
  retry?: RetryPolicy;
  recovery?: RecoveryPolicy;
}

export interface StepStateDefinition<TContext, TEvent> extends StepPolicy {
  readonly kind: 'step';
  readonly title: string;
  /**
   * Does the work of this state and returns the event to send to the machine. The machine,
   * not the step, decides where that event leads.
   *
   * Annotate the return type of inline async steps (`async (step): Promise<MyEvent> => ...`):
   * without it, TypeScript widens `type: 'DONE'` to `string` and the definition fails to
   * typecheck.
   */
  run(step: StepRunContext<TContext>): Promise<TEvent>;
}

/**
 * The execution waits here for a person. The machine state must handle both APPROVED and
 * REJECTED (ApprovalDecisionEvent); the engine sends one of them when the decision arrives.
 */
export interface ApprovalStateDefinition<TContext> {
  readonly kind: 'approval';
  readonly title: string;
  /** Stable name for the kind of review, e.g. `spec-review`. */
  readonly approvalType: string;
  /** What the reviewer is shown. Must be JSON; keep large artifacts in files and link them. */
  request(context: TContext): unknown;
}

export interface FinalStateDefinition {
  readonly kind: 'final';
  readonly title: string;
  /** Execution status once the machine reaches this state. */
  readonly status: FinalStatus;
  /** For FAILED: the error the execution reports. Defaults to WORKFLOW_FAILED and the title. */
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type StateDefinition<TContext, TEvent> =
  StepStateDefinition<TContext, TEvent> | ApprovalStateDefinition<TContext> | FinalStateDefinition;

/**
 * What a workflow author writes. Rules, checked by `defineWorkflow`:
 * - The machine is flat: top-level atomic and final states only, so a state is one string.
 * - The machine is pure: guards and `assign` only. No `invoke`, delays or other actions;
 *   all work happens in steps, which the engine runs, persists and recovers.
 * - Every machine state has exactly one entry in `states`, and the initial state is a step.
 */
export interface WorkflowSpec<TMachine extends AnyStateMachine> {
  /** kebab-case, unique in the registry, e.g. `generate-spec`. */
  id: string;
  /** Semantic version. Executions record it; a changed version is not resumed silently. */
  version: string;
  name: string;
  description: string;
  /** Free text used to group the catalog, e.g. "Documentation". */
  category: string;
  machine: TMachine;
  /** Also published as JSON Schema, so the UI can render a form for any workflow. */
  inputSchema: z.ZodType<InputFrom<TMachine>>;
  /** Validates the context every time it is persisted and every time it is read back. */
  contextSchema: z.ZodType<ContextFrom<TMachine>>;
  outputSchema: z.ZodType<OutputFrom<TMachine>>;
  /** Defaults for every step; a step's own settings win. */
  policy?: StepPolicy;
  states: Readonly<
    Record<string, StateDefinition<ContextFrom<TMachine>, EventFromLogic<TMachine>>>
  >;
}

export type StateKind = StateDefinition<unknown, unknown>['kind'];

export interface StateInfo {
  readonly name: string;
  readonly kind: StateKind;
  readonly title: string;
  readonly finalStatus: FinalStatus | null;
  readonly approvalType: string | null;
}

export interface ResolvedStepPolicy {
  readonly timeoutMs: number | null;
  readonly retry: Required<RetryPolicy>;
  readonly recovery: RecoveryPolicy;
}

export interface PreparedExecution {
  readonly input: JsonValue;
  readonly state: string;
  readonly context: JsonValue;
}

export interface RunStepRequest {
  readonly state: string;
  /** As read from storage; validated before the step sees it. */
  readonly context: unknown;
  readonly executionId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly log: Logger;
}

export interface DecideRequest {
  readonly state: string;
  readonly context: unknown;
  readonly decision: ApprovalDecision;
  readonly feedback: string | null;
}

/** The result of sending one event to the machine. */
export interface TransitionOutcome {
  /** The event, as it will be persisted. */
  readonly event: JsonObject;
  readonly eventType: string;
  readonly stateAfter: string;
  readonly context: JsonValue;
  /** Set when `stateAfter` is a final state. */
  readonly final: {
    readonly status: FinalStatus;
    readonly output: JsonValue | null;
    /** For FAILED final states: what the execution reports as its error. */
    readonly error: { readonly code: string; readonly message: string } | null;
  } | null;
  /** Set when `stateAfter` is an approval state: the request to create. */
  readonly approval: { readonly approvalType: string; readonly request: JsonValue } | null;
}

/**
 * A validated workflow, as the registry and engine see it. Types are erased at this boundary:
 * everything that crosses it is either `unknown` (validated inside) or JSON.
 */
export interface Workflow {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  /** JSON Schema (draft 2020-12) of the input, as a client sends it: defaults are optional. */
  readonly inputJsonSchema: JsonObject;
  readonly initialState: string;
  readonly states: readonly StateInfo[];
  getState(name: string): StateInfo | undefined;
  /** Timeout, retry and recovery for a step state, with defaults applied. */
  stepPolicy(state: string): ResolvedStepPolicy;
  /** Validates raw input and computes the initial state and context. */
  prepare(rawInput: unknown): PreparedExecution;
  /** Runs the step for `state`, then computes the transition its event causes. */
  runStep(request: RunStepRequest): Promise<TransitionOutcome>;
  /** Applies an approval decision to the approval state `state`. */
  decide(request: DecideRequest): TransitionOutcome;
}

const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const STATE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_NAME_LENGTH = 64;
const APPROVAL_EVENTS: readonly ApprovalDecision[] = ['APPROVED', 'REJECTED'];

const NO_RETRY: Required<RetryPolicy> = {
  maxAttempts: 1,
  initialDelayMs: 0,
  multiplier: 2,
  maxDelayMs: 60_000,
  retryOnTimeout: false,
};

const eventSchema = z.looseObject({ type: z.string().min(1) });

function validatePolicy(where: string, policy: StepPolicy | undefined): void {
  if (policy === undefined) return;
  const fail = (message: string) => new WorkflowDefinitionError(`${where}: ${message}`);
  if (policy.timeoutMs !== undefined && !(policy.timeoutMs > 0)) {
    throw fail('timeoutMs must be positive.');
  }
  const retry = policy.retry;
  if (retry !== undefined) {
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 10) {
      throw fail('retry.maxAttempts must be an integer from 1 to 10.');
    }
    if (retry.initialDelayMs < 0) throw fail('retry.initialDelayMs must not be negative.');
  }
}

function describeStates<TMachine extends AnyStateMachine>(
  spec: WorkflowSpec<TMachine>,
): {
  states: StateInfo[];
  initialState: string;
} {
  const problem = (message: string) => new WorkflowDefinitionError(`[${spec.id}] ${message}`);

  if (!WORKFLOW_ID_PATTERN.test(spec.id) || spec.id.length > MAX_NAME_LENGTH) {
    throw new WorkflowDefinitionError(
      `Workflow id "${spec.id}" must be kebab-case, at most 64 characters.`,
    );
  }
  if (!SEMVER_PATTERN.test(spec.version)) throw problem(`version "${spec.version}" must be x.y.z.`);
  if (spec.name.trim() === '') throw problem('name is empty.');
  if (spec.description.trim() === '') throw problem('description is empty.');
  if (spec.category.trim() === '') throw problem('category is empty.');
  validatePolicy(`[${spec.id}] policy`, spec.policy);

  const root = spec.machine.root;
  if (root.type !== 'compound') throw problem('the machine must have top-level states.');

  const states: StateInfo[] = [];
  for (const [name, node] of Object.entries(root.states)) {
    if (!STATE_NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
      throw problem(`state name "${name}" must match ${STATE_NAME_PATTERN.source}.`);
    }
    if (node.type !== 'atomic' && node.type !== 'final') {
      throw problem(`state "${name}" is ${node.type}; only flat machines are supported.`);
    }
    if (node.invoke.length > 0) {
      throw problem(`state "${name}" uses invoke; do the work in a step instead.`);
    }
    if (node.after.length > 0) {
      throw problem(`state "${name}" uses delayed transitions, which are not supported.`);
    }

    const definition = spec.states[name];
    if (definition === undefined) throw problem(`machine state "${name}" has no entry in states.`);
    if (definition.title.trim() === '') throw problem(`state "${name}" has an empty title.`);
    if ((node.type === 'final') !== (definition.kind === 'final')) {
      throw problem(
        `state "${name}" is ${node.type} in the machine but "${definition.kind}" in states.`,
      );
    }
    if (definition.kind === 'approval') {
      if (definition.approvalType.trim() === '') {
        throw problem(`approval state "${name}" has an empty approvalType.`);
      }
      const handled = node.ownEvents;
      for (const event of APPROVAL_EVENTS) {
        if (!handled.includes(event)) {
          throw problem(`approval state "${name}" must handle the ${event} event.`);
        }
      }
    }
    if (definition.kind === 'step') validatePolicy(`[${spec.id}] state "${name}"`, definition);

    states.push({
      name,
      kind: definition.kind,
      title: definition.title,
      finalStatus: definition.kind === 'final' ? definition.status : null,
      approvalType: definition.kind === 'approval' ? definition.approvalType : null,
    });
  }

  for (const name of Object.keys(spec.states)) {
    if (!(name in root.states)) throw problem(`states.${name} does not exist in the machine.`);
  }

  const initial: unknown = spec.machine.config.initial;
  if (typeof initial !== 'string') throw problem('the machine must name its initial state.');
  if (spec.states[initial]?.kind !== 'step') {
    throw problem(`initial state "${initial}" must be a step.`);
  }

  return { states, initialState: initial };
}

export function defineWorkflow<TMachine extends AnyStateMachine>(
  spec: WorkflowSpec<TMachine>,
): Workflow {
  const { states, initialState } = describeStates(spec);
  const byName = new Map(states.map((state) => [state.name, state]));
  // `unrepresentable: 'any'` keeps definition working for types JSON Schema cannot express;
  // the server validates with the Zod schema either way.
  const inputJsonSchema = z.toJSONSchema(spec.inputSchema, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonObject;
  // From here on the machine is handled through its erased type. Everything coming out of it
  // is validated with the workflow's own schemas before it is used or stored.
  const machine: AnyStateMachine = spec.machine;

  const fail = (code: string, message: string, cause?: unknown): never => {
    throw new WorkflowEngineError(code, `[${spec.id}] ${message}`, { cause });
  };

  const assertPure = (actions: readonly { type: string }[]) => {
    if (actions.length > 0) {
      fail(
        ENGINE_ERROR_CODES.unsupportedMachineAction,
        `the machine requested actions [${actions.map((a) => a.type).join(', ')}]. Only assign is supported.`,
      );
    }
  };

  const validContext = (value: unknown, when: string): JsonValue => {
    const result = jsonRoundTrip(spec.contextSchema, value);
    return result.success
      ? result.json
      : fail(ENGINE_ERROR_CODES.invalidContext, `context ${when} is invalid: ${result.message}`);
  };

  const readContext = (value: unknown) => {
    const context = spec.contextSchema.safeParse(value);
    return context.success
      ? context.data
      : fail(
          ENGINE_ERROR_CODES.invalidContext,
          `stored context is invalid: ${context.error.message}`,
        );
  };

  /** Sends one event to the machine in `state` and validates everything that comes out. */
  const applyEvent = (state: string, context: unknown, raw: unknown): TransitionOutcome => {
    // Transition on the JSON copy, so the result depends only on what gets persisted.
    const event = jsonRoundTrip(eventSchema, raw);
    if (!event.success) {
      return fail(
        ENGINE_ERROR_CODES.invalidTransition,
        `invalid event in "${state}": ${event.message}`,
      );
    }

    const snapshot = machine.resolveState({ value: state, context });
    if (!snapshot.can(event.data)) {
      return fail(
        ENGINE_ERROR_CODES.invalidTransition,
        `state "${state}" does not accept event "${event.data.type}".`,
      );
    }

    const [next, actions] = transition(machine, snapshot, event.data);
    assertPure(actions);

    const stateAfter: unknown = next.value;
    const after = typeof stateAfter === 'string' ? byName.get(stateAfter) : undefined;
    if (after === undefined) {
      return fail(
        ENGINE_ERROR_CODES.invalidState,
        `transition led to ${JSON.stringify(stateAfter)}.`,
      );
    }

    const nextContext = validContext(next.context, `after ${event.data.type}`);

    let final: TransitionOutcome['final'] = null;
    if (after.finalStatus === 'COMPLETED') {
      const output = jsonRoundTrip(spec.outputSchema, next.output);
      if (!output.success) {
        return fail(ENGINE_ERROR_CODES.invalidOutput, `output is invalid: ${output.message}`);
      }
      final = { status: 'COMPLETED', output: output.json, error: null };
    } else if (after.finalStatus !== null) {
      const definition = spec.states[after.name];
      const error =
        after.finalStatus === 'FAILED' && definition?.kind === 'final'
          ? {
              code: definition.errorCode ?? ENGINE_ERROR_CODES.workflowFailed,
              message: definition.errorMessage ?? `The workflow ended in "${after.title}".`,
            }
          : null;
      final = { status: after.finalStatus, output: null, error };
    }

    let approval: TransitionOutcome['approval'] = null;
    const afterDefinition = spec.states[after.name];
    if (afterDefinition?.kind === 'approval') {
      const request = jsonRoundTrip(z.unknown(), afterDefinition.request(readContext(nextContext)));
      if (!request.success) {
        return fail(
          ENGINE_ERROR_CODES.invalidContext,
          `approval request for "${after.name}" is not JSON: ${request.message}`,
        );
      }
      approval = { approvalType: afterDefinition.approvalType, request: request.json };
    }

    return {
      event: event.json as JsonObject,
      eventType: event.data.type,
      stateAfter: after.name,
      context: nextContext,
      final,
      approval,
    };
  };

  return {
    id: spec.id,
    version: spec.version,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    inputJsonSchema,
    initialState,
    states,
    getState: (name) => byName.get(name),

    stepPolicy(state) {
      const definition = spec.states[state];
      const own: StepPolicy = definition?.kind === 'step' ? definition : {};
      const defaults: StepPolicy = spec.policy ?? {};
      return {
        timeoutMs: own.timeoutMs ?? defaults.timeoutMs ?? null,
        retry: { ...NO_RETRY, ...(own.retry ?? defaults.retry) },
        recovery: own.recovery ?? defaults.recovery ?? 'manual',
      };
    },

    prepare(rawInput) {
      const parsed = spec.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new InputValidationError(
          parsed.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        );
      }

      const input = jsonRoundTrip(z.unknown(), parsed.data);
      if (!input.success) return fail(ENGINE_ERROR_CODES.invalidContext, `input: ${input.message}`);

      const [snapshot, actions] = initialTransition(machine, parsed.data);
      assertPure(actions);
      const state: unknown = snapshot.value;
      if (typeof state !== 'string' || byName.get(state)?.kind !== 'step') {
        return fail(
          ENGINE_ERROR_CODES.invalidState,
          `initial state resolved to ${JSON.stringify(state)}.`,
        );
      }
      return { input: input.json, state, context: validContext(snapshot.context, 'at start') };
    },

    async runStep(request) {
      const definition = spec.states[request.state];
      if (definition?.kind !== 'step') {
        return fail(ENGINE_ERROR_CODES.invalidState, `"${request.state}" is not a step state.`);
      }
      const context = readContext(request.context);
      const returned = await definition.run({
        executionId: request.executionId,
        stepId: request.state,
        attempt: request.attempt,
        context,
        signal: request.signal,
        log: request.log,
      });
      return applyEvent(request.state, context, returned);
    },

    decide(request) {
      if (spec.states[request.state]?.kind !== 'approval') {
        return fail(
          ENGINE_ERROR_CODES.invalidState,
          `"${request.state}" is not an approval state.`,
        );
      }
      const event: ApprovalDecisionEvent = { type: request.decision, feedback: request.feedback };
      return applyEvent(request.state, readContext(request.context), event);
    },
  };
}
