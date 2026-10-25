import { setTimeout as sleep } from 'node:timers/promises';
import { StepError, defineWorkflow, type ApprovalDecisionEvent } from '@aap/workflow-core';
import { assign, setup } from 'xstate';
import { z } from 'zod';

const inputSchema = z.object({
  items: z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(20)
    .meta({ title: 'Items', description: 'Between 1 and 20 short texts. Duplicates are dropped.' }),
  stepDelayMs: z.number().int().min(0).max(10_000).default(500).meta({
    title: 'Delay per step (ms)',
    description: 'Pause per step and per item, so progress is visible.',
  }),
  requireReview: z.boolean().default(true).meta({
    title: 'Ask for review',
    description: 'Wait for a person to approve the summary before finishing.',
  }),
  simulateFailures: z.number().int().min(0).max(5).default(0).meta({
    title: 'Simulated failures',
    description: 'Make "Process items" fail this many times first. It retries up to 3 attempts.',
  }),
});

const contextSchema = z.object({
  items: z.array(z.string()),
  stepDelayMs: z.number().int(),
  requireReview: z.boolean(),
  simulateFailures: z.number().int(),
  results: z.array(z.string()),
  summary: z.string().nullable(),
  reviewFeedback: z.string().nullable(),
});

const outputSchema = z.object({
  count: z.number().int(),
  results: z.array(z.string()),
  summary: z.string(),
  reviewFeedback: z.string().nullable(),
});

type Context = z.infer<typeof contextSchema>;
type Event =
  | { type: 'NORMALIZED'; items: string[] }
  | { type: 'PROCESSED'; results: string[] }
  | { type: 'SUMMARIZED'; summary: string }
  | ApprovalDecisionEvent;

const machine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as z.infer<typeof inputSchema>,
    output: {} as z.infer<typeof outputSchema>,
  },
  guards: {
    reviewRequired: ({ context }) => context.requireReview,
  },
}).createMachine({
  id: 'demo-sequence',
  initial: 'NORMALIZE',
  context: ({ input }) => ({
    items: input.items,
    stepDelayMs: input.stepDelayMs,
    requireReview: input.requireReview,
    simulateFailures: input.simulateFailures,
    results: [],
    summary: null,
    reviewFeedback: null,
  }),
  states: {
    NORMALIZE: {
      on: {
        NORMALIZED: { target: 'PROCESS', actions: assign({ items: ({ event }) => event.items }) },
      },
    },
    PROCESS: {
      on: {
        PROCESSED: {
          target: 'SUMMARIZE',
          actions: assign({ results: ({ event }) => event.results }),
        },
      },
    },
    SUMMARIZE: {
      on: {
        SUMMARIZED: [
          {
            guard: 'reviewRequired',
            target: 'REVIEW',
            actions: assign({ summary: ({ event }) => event.summary }),
          },
          { target: 'DONE', actions: assign({ summary: ({ event }) => event.summary }) },
        ],
      },
    },
    REVIEW: {
      on: {
        APPROVED: {
          target: 'DONE',
          actions: assign({ reviewFeedback: ({ event }) => event.feedback }),
        },
        REJECTED: {
          target: 'REJECTED',
          actions: assign({ reviewFeedback: ({ event }) => event.feedback }),
        },
      },
    },
    DONE: { type: 'final' },
    REJECTED: { type: 'final' },
  },
  output: ({ context }) => ({
    count: context.results.length,
    results: context.results,
    summary: context.summary ?? '',
    reviewFeedback: context.reviewFeedback,
  }),
});

export const demoSequenceWorkflow = defineWorkflow({
  id: 'demo-sequence',
  version: '2.0.0',
  name: 'Demo sequence',
  description:
    'Walks a short list of items through three steps, then optionally waits for your review. Uses no AI and touches no files: use it to try the platform.',
  category: 'Demo',
  machine,
  inputSchema,
  contextSchema,
  outputSchema,
  // Every step here is pure, so it is safe to re-run after a crash.
  policy: { recovery: 'rerun', timeoutMs: 5 * 60_000 },
  states: {
    NORMALIZE: {
      kind: 'step',
      title: 'Normalize items',
      run: async ({ context, signal }): Promise<Event> => {
        await sleep(context.stepDelayMs, undefined, { signal });
        const seen = new Set<string>();
        const items = context.items.filter((item) => {
          const key = item.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return { type: 'NORMALIZED', items };
      },
    },
    PROCESS: {
      kind: 'step',
      title: 'Process items',
      retry: { maxAttempts: 3, initialDelayMs: 1_000, multiplier: 2 },
      run: async ({ context, signal, log, attempt }): Promise<Event> => {
        if (attempt <= context.simulateFailures) {
          await sleep(context.stepDelayMs, undefined, { signal });
          throw new StepError(`Simulated failure ${attempt} of ${context.simulateFailures}.`, {
            code: 'SIMULATED_FAILURE',
            retryable: true,
          });
        }
        const results: string[] = [];
        for (const [index, item] of context.items.entries()) {
          await sleep(context.stepDelayMs, undefined, { signal });
          results.push(item.toUpperCase());
          log.debug({ item: index + 1, of: context.items.length }, 'Processed item');
        }
        return { type: 'PROCESSED', results };
      },
    },
    SUMMARIZE: {
      kind: 'step',
      title: 'Summarize',
      run: async ({ context, signal }): Promise<Event> => {
        await sleep(context.stepDelayMs, undefined, { signal });
        return {
          type: 'SUMMARIZED',
          summary: `Processed ${context.results.length} item(s): ${context.results.join(', ')}.`,
        };
      },
    },
    REVIEW: {
      kind: 'approval',
      title: 'Review summary',
      approvalType: 'summary-review',
      request: (context) => ({
        summary: context.summary,
        results: context.results,
        note: 'Approve to finish, or reject to cancel the run.',
      }),
    },
    DONE: { kind: 'final', title: 'Done', status: 'COMPLETED' },
    REJECTED: { kind: 'final', title: 'Rejected', status: 'CANCELLED' },
  },
});
