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

export interface StepRunContext<TContext> {
  readonly executionId: string;
  /** Name of the machine state this step belongs to. */
  readonly stepId: string;
  /** 1 on the first run of this step in this execution. */
  readonly attempt: number;
  readonly context: TContext;
  /** Aborted when the app shuts down. Long-running steps must honour it. */
  readonly signal: AbortSignal;
  readonly log: Logger;
}

export interface StepStateDefinition<TContext, TEvent> {
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

export interface FinalStateDefinition {
  readonly kind: 'final';
  readonly title: string;
  /** Execution status once the machine reaches this state. */
  readonly status: FinalStatus;
}

export type StateDefinition<TContext, TEvent> =
  StepStateDefinition<TContext, TEvent> | FinalStateDefinition;

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
  machine: TMachine;
  inputSchema: z.ZodType<InputFrom<TMachine>>;
  /** Validates the context every time it is persisted and every time it is read back. */
  contextSchema: z.ZodType<ContextFrom<TMachine>>;
  outputSchema: z.ZodType<OutputFrom<TMachine>>;
  states: Readonly<
    Record<string, StateDefinition<ContextFrom<TMachine>, EventFromLogic<TMachine>>>
  >;
}

export interface StateInfo {
  readonly name: string;
  readonly kind: 'step' | 'final';
  readonly title: string;
  readonly finalStatus: FinalStatus | null;
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

export interface StepOutcome {
  /** The event the step returned, as it will be persisted. */
  readonly event: JsonObject;
  readonly eventType: string;
  readonly stateAfter: string;
  readonly context: JsonValue;
  /** Set when `stateAfter` is a final state. */
  readonly final: { readonly status: FinalStatus; readonly output: JsonValue | null } | null;
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
  readonly initialState: string;
  readonly states: readonly StateInfo[];
  getState(name: string): StateInfo | undefined;
  /** Validates raw input and computes the initial state and context. */
  prepare(rawInput: unknown): PreparedExecution;
  /** Runs the step for `state`, then computes the transition its event causes. */
  runStep(request: RunStepRequest): Promise<StepOutcome>;
}

const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const STATE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_NAME_LENGTH = 64;

const eventSchema = z.looseObject({ type: z.string().min(1) });

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
    states.push({
      name,
      kind: definition.kind,
      title: definition.title,
      finalStatus: definition.kind === 'final' ? definition.status : null,
    });
  }

  for (const name of Object.keys(spec.states)) {
    if (!(name in root.states)) throw problem(`states.${name} does not exist in the machine.`);
  }

  const initial: unknown = spec.machine.config.initial;
  if (typeof initial !== 'string') throw problem('the machine must name its initial state.');
  if (spec.states[initial]?.kind !== 'step')
    throw problem(`initial state "${initial}" must be a step.`);

  return { states, initialState: initial };
}

export function defineWorkflow<TMachine extends AnyStateMachine>(
  spec: WorkflowSpec<TMachine>,
): Workflow {
  const { states, initialState } = describeStates(spec);
  const byName = new Map(states.map((state) => [state.name, state]));
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

  return {
    id: spec.id,
    version: spec.version,
    name: spec.name,
    description: spec.description,
    initialState,
    states,
    getState: (name) => byName.get(name),

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

      const context = spec.contextSchema.safeParse(request.context);
      if (!context.success) {
        return fail(
          ENGINE_ERROR_CODES.invalidContext,
          `stored context is invalid: ${context.error.message}`,
        );
      }

      const returned = await definition.run({
        executionId: request.executionId,
        stepId: request.state,
        attempt: request.attempt,
        context: context.data,
        signal: request.signal,
        log: request.log,
      });

      // Transition on the JSON copy, so the result depends only on what gets persisted.
      const event = jsonRoundTrip(eventSchema, returned);
      if (!event.success) {
        return fail(
          ENGINE_ERROR_CODES.invalidTransition,
          `step "${request.state}" returned an invalid event: ${event.message}`,
        );
      }

      const snapshot = machine.resolveState({ value: request.state, context: context.data });
      if (!snapshot.can(event.data)) {
        return fail(
          ENGINE_ERROR_CODES.invalidTransition,
          `state "${request.state}" does not accept event "${event.data.type}".`,
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

      let final: StepOutcome['final'] = null;
      if (after.finalStatus === 'COMPLETED') {
        const output = jsonRoundTrip(spec.outputSchema, next.output);
        if (!output.success) {
          return fail(ENGINE_ERROR_CODES.invalidOutput, `output is invalid: ${output.message}`);
        }
        final = { status: 'COMPLETED', output: output.json };
      } else if (after.finalStatus !== null) {
        final = { status: after.finalStatus, output: null };
      }

      return {
        event: event.json as JsonObject,
        eventType: event.data.type,
        stateAfter: after.name,
        context: validContext(next.context, `after ${event.data.type}`),
        final,
      };
    },
  };
}
