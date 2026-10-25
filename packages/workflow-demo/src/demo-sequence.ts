import { setTimeout as sleep } from 'node:timers/promises';
import { defineWorkflow } from '@aap/workflow-core';
import { assign, setup } from 'xstate';
import { z } from 'zod';

const inputSchema = z.object({
  items: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  /** Pause per step and per processed item, so progress is visible in the UI. */
  stepDelayMs: z.number().int().min(0).max(10_000).default(500),
});

const contextSchema = z.object({
  items: z.array(z.string()),
  stepDelayMs: z.number().int(),
  results: z.array(z.string()),
  summary: z.string().nullable(),
});

const outputSchema = z.object({
  count: z.number().int(),
  results: z.array(z.string()),
  summary: z.string(),
});

type Context = z.infer<typeof contextSchema>;
type Event =
  | { type: 'NORMALIZED'; items: string[] }
  | { type: 'PROCESSED'; results: string[] }
  | { type: 'SUMMARIZED'; summary: string };

const machine = setup({
  types: {
    context: {} as Context,
    events: {} as Event,
    input: {} as z.infer<typeof inputSchema>,
    output: {} as z.infer<typeof outputSchema>,
  },
}).createMachine({
  id: 'demo-sequence',
  initial: 'NORMALIZE',
  context: ({ input }) => ({
    items: input.items,
    stepDelayMs: input.stepDelayMs,
    results: [],
    summary: null,
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
        SUMMARIZED: { target: 'DONE', actions: assign({ summary: ({ event }) => event.summary }) },
      },
    },
    DONE: { type: 'final' },
  },
  output: ({ context }) => ({
    count: context.results.length,
    results: context.results,
    summary: context.summary ?? '',
  }),
});

export const demoSequenceWorkflow = defineWorkflow({
  id: 'demo-sequence',
  version: '1.0.0',
  name: 'Demo sequence',
  description:
    'Walks a short list of items through three steps. Uses no AI and touches no files: use it to try the platform.',
  machine,
  inputSchema,
  contextSchema,
  outputSchema,
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
      run: async ({ context, signal, log }): Promise<Event> => {
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
    DONE: { kind: 'final', title: 'Done', status: 'COMPLETED' },
  },
});
