import { assign, fromPromise, setup } from 'xstate';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InputValidationError,
  WorkflowDefinitionError,
  WorkflowEngineError,
  defineWorkflow,
  silentLogger,
  type RunStepRequest,
} from '../src/index.js';
import { createSequenceWorkflow, sequenceMachine } from './fixtures/sequence-workflow.js';

const context = z.object({ n: z.number() });

function request(overrides: Partial<RunStepRequest>): RunStepRequest {
  return {
    state: 'FIRST',
    context: { label: 'x', trail: [] },
    executionId: 'e1',
    attempt: 1,
    signal: new AbortController().signal,
    log: silentLogger,
    ...overrides,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof WorkflowEngineError)) throw new Error('expected a WorkflowEngineError');
  return error.code;
}

describe('defineWorkflow validation', () => {
  it('accepts a well-formed workflow and describes its states', () => {
    const workflow = createSequenceWorkflow();

    expect(workflow.initialState).toBe('FIRST');
    expect(workflow.states.map((s) => [s.name, s.kind, s.finalStatus])).toEqual([
      ['FIRST', 'step', null],
      ['SECOND', 'step', null],
      ['DONE', 'final', 'COMPLETED'],
      ['REJECTED', 'final', 'CANCELLED'],
    ]);
  });

  it.each(['Fix_Bug', 'fix bug', '-fix', 'fix-', ''])('rejects workflow id %j', (id) => {
    expect(() => defineWorkflow({ ...specFor(sequenceMachine), id })).toThrow(
      WorkflowDefinitionError,
    );
  });

  it('rejects a version that is not x.y.z', () => {
    expect(() => defineWorkflow({ ...specFor(sequenceMachine), version: '1.0' })).toThrow(
      /version/,
    );
  });

  it('rejects nested states', () => {
    const machine = setup({ types: { context: {} as { n: number } } }).createMachine({
      initial: 'A',
      context: { n: 0 },
      states: { A: { initial: 'inner', states: { inner: {} } }, B: { type: 'final' } },
    });
    expect(() =>
      defineWorkflow({
        ...base,
        machine,
        inputSchema: z.undefined(),
        contextSchema: context,
        outputSchema: z.undefined(),
        states: {
          A: { kind: 'step', title: 'A', run: () => Promise.resolve({ type: 'X' }) },
          B: { kind: 'final', title: 'B', status: 'COMPLETED' },
        },
      }),
    ).toThrow(/only flat machines/);
  });

  it('rejects invoke, because work belongs in steps', () => {
    const machine = setup({
      actors: { work: fromPromise(() => Promise.resolve(1)) },
    }).createMachine({
      initial: 'A',
      states: { A: { invoke: { src: 'work', onDone: 'B' } }, B: { type: 'final' } },
    });
    expect(() =>
      defineWorkflow({
        ...base,
        machine,
        inputSchema: z.undefined(),
        contextSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.undefined(),
        states: {
          A: { kind: 'step', title: 'A', run: () => Promise.resolve({ type: 'X' }) },
          B: { kind: 'final', title: 'B', status: 'COMPLETED' },
        },
      }),
    ).toThrow(/invoke/);
  });

  it('rejects a machine state without a definition, and a definition without a state', () => {
    const { SECOND: omitted, ...missing } = specFor(sequenceMachine).states;
    expect(() => defineWorkflow({ ...specFor(sequenceMachine), states: missing })).toThrow(
      /"SECOND" has no entry/,
    );
    expect(() =>
      defineWorkflow({
        ...specFor(sequenceMachine),
        states: {
          ...specFor(sequenceMachine).states,
          EXTRA: { kind: 'final', title: 'Extra', status: 'COMPLETED' },
        },
      }),
    ).toThrow(/EXTRA does not exist/);
  });

  it('rejects a final machine state declared as a step', () => {
    const spec = specFor(sequenceMachine);
    expect(() =>
      defineWorkflow({
        ...spec,
        states: {
          ...spec.states,
          DONE: {
            kind: 'step',
            title: 'Done',
            run: () => Promise.resolve({ type: 'REJECT' as const }),
          },
        },
      }),
    ).toThrow(/"DONE" is final in the machine/);
  });
});

describe('Workflow.prepare', () => {
  it('rejects invalid input with field paths', () => {
    const workflow = createSequenceWorkflow();
    try {
      workflow.prepare({ label: '' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as InputValidationError).issues[0]?.path).toBe('label');
    }
  });

  it('computes the initial state and JSON context', () => {
    expect(createSequenceWorkflow().prepare({ label: 'a' })).toEqual({
      input: { label: 'a' },
      state: 'FIRST',
      context: { label: 'a', trail: [] },
    });
  });
});

describe('Workflow.runStep', () => {
  it('runs the step and applies the transition its event causes', async () => {
    const outcome = await createSequenceWorkflow().runStep(request({}));

    expect(outcome).toEqual({
      event: { type: 'NEXT', mark: 'first' },
      eventType: 'NEXT',
      stateAfter: 'SECOND',
      context: { label: 'x', trail: ['first'] },
      final: null,
    });
  });

  it('validates and returns the output on a COMPLETED final state', async () => {
    const outcome = await createSequenceWorkflow().runStep(
      request({ state: 'SECOND', context: { label: 'x', trail: ['first'] } }),
    );

    expect(outcome.final).toEqual({
      status: 'COMPLETED',
      output: { label: 'x', trail: ['first', 'second'] },
    });
  });

  it('rejects an event the current state does not accept', async () => {
    const workflow = createSequenceWorkflow({
      FIRST: () => Promise.resolve({ type: 'UNHANDLED' as const }),
    });

    expect(await errorCode(workflow.runStep(request({})))).toBe('INVALID_TRANSITION');
  });

  it('refuses to run a step on invalid stored context', async () => {
    let ran = false;
    const workflow = createSequenceWorkflow({
      FIRST: () => {
        ran = true;
        return Promise.resolve({ type: 'NEXT', mark: 'x' });
      },
    });

    expect(await errorCode(workflow.runStep(request({ context: { label: 42 } })))).toBe(
      'INVALID_CONTEXT',
    );
    expect(ran).toBe(false);
  });

  it('refuses to run a final state', async () => {
    expect(await errorCode(createSequenceWorkflow().runStep(request({ state: 'DONE' })))).toBe(
      'INVALID_STATE',
    );
  });

  it('fails when the machine asks for an action other than assign', async () => {
    const machine = setup({
      types: { context: {} as { n: number }, events: {} as { type: 'GO' } },
      actions: { notify: () => undefined },
    }).createMachine({
      initial: 'A',
      context: { n: 0 },
      states: {
        A: { on: { GO: { target: 'B', actions: ['notify', assign({ n: 1 })] } } },
        B: { type: 'final' },
      },
    });
    const workflow = defineWorkflow({
      ...base,
      machine,
      inputSchema: z.undefined(),
      contextSchema: context,
      outputSchema: z.undefined(),
      states: {
        A: { kind: 'step', title: 'A', run: () => Promise.resolve({ type: 'GO' as const }) },
        B: { kind: 'final', title: 'B', status: 'COMPLETED' },
      },
    });

    expect(await errorCode(workflow.runStep(request({ state: 'A', context: { n: 0 } })))).toBe(
      'UNSUPPORTED_MACHINE_ACTION',
    );
  });

  it('rejects context that would not survive a JSON round trip', async () => {
    const machine = setup({
      types: { context: {} as { at: unknown }, events: {} as { type: 'GO' } },
    }).createMachine({
      initial: 'A',
      context: { at: null },
      states: {
        A: { on: { GO: { target: 'B', actions: assign({ at: () => new Date(0) }) } } },
        B: { on: { GO: 'C' } },
        C: { type: 'final' },
      },
    });
    const workflow = defineWorkflow({
      ...base,
      machine,
      inputSchema: z.undefined(),
      contextSchema: z.object({ at: z.date().nullable() }),
      outputSchema: z.undefined(),
      states: {
        A: { kind: 'step', title: 'A', run: () => Promise.resolve({ type: 'GO' as const }) },
        B: { kind: 'step', title: 'B', run: () => Promise.resolve({ type: 'GO' as const }) },
        C: { kind: 'final', title: 'C', status: 'COMPLETED' },
      },
    });

    expect(await errorCode(workflow.runStep(request({ state: 'A', context: { at: null } })))).toBe(
      'INVALID_CONTEXT',
    );
  });
});

const base = {
  id: 'probe',
  version: '1.0.0',
  name: 'Probe',
  description: 'Probe workflow.',
  category: 'Test',
};

function specFor(machine: typeof sequenceMachine) {
  return {
    ...base,
    machine,
    inputSchema: z.object({ label: z.string() }),
    contextSchema: z.object({ label: z.string(), trail: z.array(z.string()) }),
    outputSchema: z.object({ label: z.string(), trail: z.array(z.string()) }),
    states: {
      FIRST: {
        kind: 'step' as const,
        title: 'First',
        run: () => Promise.resolve({ type: 'REJECT' as const }),
      },
      SECOND: {
        kind: 'step' as const,
        title: 'Second',
        run: () => Promise.resolve({ type: 'REJECT' as const }),
      },
      DONE: { kind: 'final' as const, title: 'Done', status: 'COMPLETED' as const },
      REJECTED: { kind: 'final' as const, title: 'Rejected', status: 'CANCELLED' as const },
    },
  };
}
