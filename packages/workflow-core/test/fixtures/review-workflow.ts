import { assign, setup } from 'xstate';
import { z } from 'zod';
import {
  defineWorkflow,
  type ApprovalDecisionEvent,
  type StepPolicy,
  type StepRunContext,
} from '../../src/index.js';

const contextSchema = z.object({ draft: z.string(), feedback: z.string().nullable() });
const outputSchema = z.object({ published: z.string() });
type Context = z.infer<typeof contextSchema>;

export type ReviewEvent =
  { type: 'DRAFTED'; draft: string } | { type: 'PUBLISHED' } | ApprovalDecisionEvent;

export type ReviewStep = (step: StepRunContext<Context>) => Promise<ReviewEvent>;

export const reviewMachine = setup({
  types: {
    context: {} as Context,
    events: {} as ReviewEvent,
    input: {} as { topic: string },
    output: {} as z.infer<typeof outputSchema>,
  },
}).createMachine({
  id: 'test-review',
  initial: 'WORK',
  context: () => ({ draft: '', feedback: null }),
  states: {
    WORK: {
      on: { DRAFTED: { target: 'REVIEW', actions: assign({ draft: ({ event }) => event.draft }) } },
    },
    REVIEW: {
      on: {
        APPROVED: {
          target: 'PUBLISH',
          actions: assign({ feedback: ({ event }) => event.feedback }),
        },
        REJECTED: {
          target: 'REJECTED',
          actions: assign({ feedback: ({ event }) => event.feedback }),
        },
      },
    },
    PUBLISH: { on: { PUBLISHED: 'DONE' } },
    DONE: { type: 'final' },
    REJECTED: { type: 'final' },
  },
  output: ({ context }) => ({ published: context.draft }),
});

const draftV1: ReviewStep = () => Promise.resolve({ type: 'DRAFTED', draft: 'v1' });
const publish: ReviewStep = () => Promise.resolve({ type: 'PUBLISHED' });

/** WORK → REVIEW (approval) → PUBLISH → DONE, or REVIEW → REJECTED. */
export function createReviewWorkflow(
  options: { WORK?: ReviewStep; PUBLISH?: ReviewStep; workPolicy?: StepPolicy } = {},
) {
  return defineWorkflow({
    id: 'test-review',
    version: '1.0.0',
    name: 'Test review',
    description: 'Drafts, waits for a person, then publishes.',
    category: 'Test',
    machine: reviewMachine,
    inputSchema: z.object({ topic: z.string() }),
    contextSchema,
    outputSchema,
    states: {
      WORK: {
        kind: 'step',
        title: 'Draft',
        run: options.WORK ?? draftV1,
        ...options.workPolicy,
      },
      REVIEW: {
        kind: 'approval',
        title: 'Review draft',
        approvalType: 'draft-review',
        request: (context) => ({ draft: context.draft }),
      },
      PUBLISH: {
        kind: 'step',
        title: 'Publish',
        run: options.PUBLISH ?? publish,
      },
      DONE: { kind: 'final', title: 'Done', status: 'COMPLETED' },
      REJECTED: { kind: 'final', title: 'Rejected', status: 'CANCELLED' },
    },
  });
}
