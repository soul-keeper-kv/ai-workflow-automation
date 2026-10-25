import { assign, setup } from 'xstate';
import { z } from 'zod';
import { defineWorkflow, type StepRunContext } from '../../src/index.js';

export const sequenceInputSchema = z.object({ label: z.string().min(1) });
const contextSchema = z.object({ label: z.string(), trail: z.array(z.string()) });
const outputSchema = z.object({ label: z.string(), trail: z.array(z.string()) });

type Context = z.infer<typeof contextSchema>;
export type SequenceEvent =
  | { type: 'NEXT'; mark: string }
  | { type: 'REJECT' }
  /** Accepted by no state: lets a test make a step return an invalid event. */
  | { type: 'UNHANDLED' };

export type StepBehavior = (step: StepRunContext<Context>) => Promise<SequenceEvent>;

export const sequenceMachine = setup({
  types: {
    context: {} as Context,
    events: {} as SequenceEvent,
    input: {} as z.infer<typeof sequenceInputSchema>,
    output: {} as z.infer<typeof outputSchema>,
  },
}).createMachine({
  id: 'test-sequence',
  initial: 'FIRST',
  context: ({ input }) => ({ label: input.label, trail: [] }),
  states: {
    FIRST: {
      on: {
        NEXT: {
          target: 'SECOND',
          actions: assign({ trail: ({ context, event }) => [...context.trail, event.mark] }),
        },
        REJECT: 'REJECTED',
      },
    },
    SECOND: {
      on: {
        NEXT: {
          target: 'DONE',
          actions: assign({ trail: ({ context, event }) => [...context.trail, event.mark] }),
        },
      },
    },
    DONE: { type: 'final' },
    REJECTED: { type: 'final' },
  },
  output: ({ context }) => ({ label: context.label, trail: context.trail }),
});

const next =
  (mark: string): StepBehavior =>
  () =>
    Promise.resolve({ type: 'NEXT', mark });

/** A two-step workflow whose steps a test can replace to block, fail or misbehave. */
export function createSequenceWorkflow(
  behaviors: { FIRST?: StepBehavior; SECOND?: StepBehavior } = {},
  version = '1.0.0',
) {
  return defineWorkflow({
    id: 'test-sequence',
    version,
    name: 'Test sequence',
    description: 'Two steps, then done. Used by the engine tests.',
    machine: sequenceMachine,
    inputSchema: sequenceInputSchema,
    contextSchema,
    outputSchema,
    states: {
      FIRST: { kind: 'step', title: 'First', run: behaviors.FIRST ?? next('first') },
      SECOND: { kind: 'step', title: 'Second', run: behaviors.SECOND ?? next('second') },
      DONE: { kind: 'final', title: 'Done', status: 'COMPLETED' },
      REJECTED: { kind: 'final', title: 'Rejected', status: 'CANCELLED' },
    },
  });
}
