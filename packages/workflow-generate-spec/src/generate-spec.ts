import { basename } from 'node:path';
import {
  CodingAgentError,
  PathNotAllowedError,
  type CodingAgent,
  type WorkspaceFilesystem,
} from '@aap/integrations';
import { StepError, defineWorkflow, type ApprovalDecisionEvent } from '@aap/workflow-core';
import { assign, setup } from 'xstate';
import { z } from 'zod';
import {
  analyzeFile,
  sourceAnalysisSchema,
  summarize,
  type FileFacts,
  type SourceAnalysis,
} from './source-analysis.js';
import { buildSpecPrompt, checkSpec, unwrapMarkdown } from './spec-format.js';

export const DEFAULT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.vue',
  '.svelte',
  '.html',
  '.css',
  '.scss',
  '.java',
  '.kt',
  '.cs',
  '.py',
  '.go',
  '.rb',
  '.php',
  '.sql',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
];

export interface GenerateSpecLimits {
  maxFiles: number;
  maxFileBytes: number;
  /** Total source read for static analysis. */
  analysisBudgetBytes: number;
  agentTimeoutMs: number;
  maxSpecBytes: number;
  /** Drafts generated before giving up on automatic checks. */
  maxGenerationAttempts: number;
  /** Wait before retrying a rate-limited agent call. */
  agentRetryDelayMs: number;
}

export const DEFAULT_GENERATE_SPEC_LIMITS: GenerateSpecLimits = {
  maxFiles: 200,
  maxFileBytes: 256 * 1024,
  analysisBudgetBytes: 4 * 1024 * 1024,
  agentTimeoutMs: 20 * 60_000,
  maxSpecBytes: 256 * 1024,
  maxGenerationAttempts: 2,
  agentRetryDelayMs: 15_000,
};

export interface GenerateSpecDependencies {
  filesystem: WorkspaceFilesystem;
  codingAgent: CodingAgent;
  limits?: Partial<GenerateSpecLimits>;
}

const inputSchema = z.object({
  sourceDirectory: z.string().trim().min(1).max(1000).meta({
    title: 'Source directory',
    description:
      'Absolute path of the code to describe. Must be inside an allowed workspace folder.',
  }),
  outputDirectory: z.string().trim().min(1).max(1000).meta({
    title: 'Output directory',
    description:
      'Absolute path where the approved spec is saved. Created if missing; must be inside an allowed workspace folder.',
  }),
  specTitle: z.string().trim().min(1).max(120).optional().meta({
    title: 'Spec title',
    description: 'Defaults to the name of the source folder.',
  }),
  instructions: z.string().trim().max(2000).optional().meta({
    title: 'Analysis instructions',
    description: 'What to focus on, for example "only the customer search screen".',
  }),
  extensions: z
    .array(z.string().regex(/^\.[A-Za-z0-9]+$/, 'must look like .tsx'))
    .min(1)
    .max(30)
    .optional()
    .meta({
      title: 'File extensions',
      description: 'Files to include, e.g. .tsx. Defaults to common source file types.',
    }),
});

const discoveredFileSchema = z.object({ path: z.string(), bytes: z.number().int() });

const contextSchema = z.object({
  request: z.object({
    sourceDirectory: z.string(),
    outputDirectory: z.string(),
    specTitle: z.string().nullable(),
    instructions: z.string().nullable(),
    extensions: z.array(z.string()),
  }),
  sourceRoot: z.string().nullable(),
  outputRoot: z.string().nullable(),
  title: z.string().nullable(),
  files: z.array(discoveredFileSchema),
  skippedFiles: z.number().int(),
  listTruncated: z.boolean(),
  analysis: sourceAnalysisSchema.nullable(),
  markdown: z.string().nullable(),
  generationAttempts: z.number().int(),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
  agent: z
    .object({ id: z.string(), displayName: z.string(), costUsd: z.number().nullable() })
    .nullable(),
  reviewFeedback: z.string().nullable(),
  exportedPath: z.string().nullable(),
  exportedBytes: z.number().int().nullable(),
});

const outputSchema = z.object({
  specPath: z.string(),
  bytes: z.number().int(),
  title: z.string(),
  fileCount: z.number().int(),
  warnings: z.array(z.string()),
  reviewFeedback: z.string().nullable(),
  agent: z.string(),
  costUsd: z.number().nullable(),
});

type Context = z.infer<typeof contextSchema>;
type Event =
  | { type: 'INPUT_VALID'; sourceRoot: string; outputRoot: string; title: string }
  | {
      type: 'SOURCE_DISCOVERED';
      files: { path: string; bytes: number }[];
      skippedFiles: number;
      listTruncated: boolean;
    }
  | { type: 'SOURCE_ANALYZED'; analysis: SourceAnalysis }
  | {
      type: 'SPEC_GENERATED';
      markdown: string;
      agent: { id: string; displayName: string; costUsd: number | null };
    }
  | { type: 'SPEC_VALID'; warnings: string[] }
  | { type: 'SPEC_INVALID'; problems: string[] }
  | { type: 'EXPORTED'; path: string; bytes: number }
  | ApprovalDecisionEvent;

function slug(text: string): string {
  const value = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return value === '' ? 'spec' : value;
}

/** Workspace and agent errors become StepErrors with stable codes; only rate limits retry. */
function asStepError(error: unknown): unknown {
  if (error instanceof PathNotAllowedError) {
    return new StepError(error.message, { code: 'PATH_NOT_ALLOWED', cause: error });
  }
  if (error instanceof CodingAgentError) {
    return new StepError(error.message, {
      code: error.code,
      retryable: error.retryable,
      cause: error,
    });
  }
  return error;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asStepError(error);
  }
}

/** The workflow, wired to its integrations. The backend passes real ones; tests pass fakes. */
export function createGenerateSpecWorkflow(dependencies: GenerateSpecDependencies) {
  const { filesystem, codingAgent } = dependencies;
  const limits = { ...DEFAULT_GENERATE_SPEC_LIMITS, ...dependencies.limits };

  const machine = setup({
    types: {
      context: {} as Context,
      events: {} as Event,
      input: {} as z.infer<typeof inputSchema>,
      output: {} as z.infer<typeof outputSchema>,
    },
    guards: {
      mayRegenerate: ({ context }) => context.generationAttempts < limits.maxGenerationAttempts,
    },
  }).createMachine({
    id: 'generate-spec',
    initial: 'VALIDATE_INPUT',
    context: ({ input }) => ({
      request: {
        sourceDirectory: input.sourceDirectory,
        outputDirectory: input.outputDirectory,
        specTitle: input.specTitle ?? null,
        instructions: input.instructions ?? null,
        extensions: (input.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()),
      },
      sourceRoot: null,
      outputRoot: null,
      title: null,
      files: [],
      skippedFiles: 0,
      listTruncated: false,
      analysis: null,
      markdown: null,
      generationAttempts: 0,
      problems: [],
      warnings: [],
      agent: null,
      reviewFeedback: null,
      exportedPath: null,
      exportedBytes: null,
    }),
    states: {
      VALIDATE_INPUT: {
        on: {
          INPUT_VALID: {
            target: 'DISCOVER_SOURCE',
            actions: assign({
              sourceRoot: ({ event }) => event.sourceRoot,
              outputRoot: ({ event }) => event.outputRoot,
              title: ({ event }) => event.title,
            }),
          },
        },
      },
      DISCOVER_SOURCE: {
        on: {
          SOURCE_DISCOVERED: {
            target: 'ANALYZE_SOURCE',
            actions: assign({
              files: ({ event }) => event.files,
              skippedFiles: ({ event }) => event.skippedFiles,
              listTruncated: ({ event }) => event.listTruncated,
            }),
          },
        },
      },
      ANALYZE_SOURCE: {
        on: {
          SOURCE_ANALYZED: {
            target: 'GENERATE_SPEC',
            actions: assign({ analysis: ({ event }) => event.analysis }),
          },
        },
      },
      GENERATE_SPEC: {
        on: {
          SPEC_GENERATED: {
            target: 'VALIDATE_SPEC',
            actions: assign({
              markdown: ({ event }) => event.markdown,
              agent: ({ event }) => event.agent,
              generationAttempts: ({ context }) => context.generationAttempts + 1,
            }),
          },
        },
      },
      VALIDATE_SPEC: {
        on: {
          SPEC_VALID: {
            target: 'AWAIT_REVIEW',
            actions: assign({ warnings: ({ event }) => event.warnings, problems: [] }),
          },
          SPEC_INVALID: [
            {
              guard: 'mayRegenerate',
              target: 'GENERATE_SPEC',
              actions: assign({ problems: ({ event }) => event.problems }),
            },
            {
              target: 'INVALID_SPEC',
              actions: assign({ problems: ({ event }) => event.problems }),
            },
          ],
        },
      },
      AWAIT_REVIEW: {
        on: {
          APPROVED: {
            target: 'EXPORT_RESULT',
            actions: assign({ reviewFeedback: ({ event }) => event.feedback }),
          },
          REJECTED: {
            target: 'REJECTED',
            actions: assign({ reviewFeedback: ({ event }) => event.feedback }),
          },
        },
      },
      EXPORT_RESULT: {
        on: {
          EXPORTED: {
            target: 'DONE',
            actions: assign({
              exportedPath: ({ event }) => event.path,
              exportedBytes: ({ event }) => event.bytes,
            }),
          },
        },
      },
      DONE: { type: 'final' },
      REJECTED: { type: 'final' },
      INVALID_SPEC: { type: 'final' },
    },
    output: ({ context }) => ({
      specPath: context.exportedPath ?? '',
      bytes: context.exportedBytes ?? 0,
      title: context.title ?? '',
      fileCount: context.files.length,
      warnings: context.warnings,
      reviewFeedback: context.reviewFeedback,
      agent: context.agent?.displayName ?? '',
      costUsd: context.agent?.costUsd ?? null,
    }),
  });

  const requireValue = <T>(value: T | null, what: string): T => {
    if (value === null) throw new StepError(`Missing ${what}.`, { code: 'INVALID_STATE' });
    return value;
  };

  return defineWorkflow({
    id: 'generate-spec',
    version: '1.0.0',
    name: 'Generate spec',
    description:
      'Reads a source folder and drafts a Markdown specification of the screen it implements: facts from the code, assumptions listed separately. You review the draft before it is saved.',
    category: 'Documentation',
    machine,
    inputSchema,
    contextSchema,
    outputSchema,
    // Reading, analysing, checking and exporting (to a per-execution file) can be repeated
    // safely. Generation calls an external agent and is not re-run after a crash.
    policy: { recovery: 'rerun', timeoutMs: 5 * 60_000 },
    states: {
      VALIDATE_INPUT: {
        kind: 'step',
        title: 'Validate input',
        run: ({ context }): Promise<Event> =>
          guarded(async () => {
            const sourceRoot = await filesystem.resolveDirectory(context.request.sourceDirectory);
            const outputRoot = await filesystem.ensureOutputDirectory(
              context.request.outputDirectory,
            );
            return {
              type: 'INPUT_VALID',
              sourceRoot,
              outputRoot,
              title: context.request.specTitle ?? `${basename(sourceRoot)} specification`,
            };
          }),
      },
      DISCOVER_SOURCE: {
        kind: 'step',
        title: 'Discover source files',
        run: ({ context }): Promise<Event> =>
          guarded(async () => {
            const listed = await filesystem.listFiles(requireValue(context.sourceRoot, 'source'), {
              extensions: context.request.extensions,
              maxFiles: limits.maxFiles,
              maxFileBytes: limits.maxFileBytes,
              excludePaths: context.outputRoot === null ? [] : [context.outputRoot],
            });
            if (listed.files.length === 0) {
              throw new StepError(
                `No files with extensions ${context.request.extensions.join(', ')} were found in the source directory.`,
                { code: 'NO_SOURCE_FILES' },
              );
            }
            return {
              type: 'SOURCE_DISCOVERED',
              files: listed.files,
              skippedFiles: listed.skipped.length,
              listTruncated: listed.truncated,
            };
          }),
      },
      ANALYZE_SOURCE: {
        kind: 'step',
        title: 'Analyse source',
        run: ({ context, signal }): Promise<Event> =>
          guarded(async () => {
            const root = requireValue(context.sourceRoot, 'source');
            const facts: FileFacts[] = [];
            let budget = limits.analysisBudgetBytes;
            for (const file of context.files) {
              signal.throwIfAborted();
              if (file.bytes > budget) break;
              budget -= file.bytes;
              facts.push(
                analyzeFile(file.path, await filesystem.readText(root, file.path, file.bytes)),
              );
            }
            return { type: 'SOURCE_ANALYZED', analysis: summarize(facts) };
          }),
      },
      GENERATE_SPEC: {
        kind: 'step',
        title: 'Generate draft spec',
        recovery: 'manual',
        timeoutMs: limits.agentTimeoutMs + 30_000,
        retry: { maxAttempts: 2, initialDelayMs: limits.agentRetryDelayMs },
        run: ({ context, signal }): Promise<Event> =>
          guarded(async () => {
            const prompt = buildSpecPrompt({
              title: requireValue(context.title, 'title'),
              files: context.files,
              analysis: requireValue(context.analysis, 'analysis'),
              instructions: context.request.instructions,
              previousProblems: context.problems,
            });
            const result = await codingAgent.execute({
              workingDirectory: requireValue(context.sourceRoot, 'source'),
              prompt,
              mode: 'read-only',
              timeoutMs: limits.agentTimeoutMs,
              signal,
            });
            const markdown = unwrapMarkdown(result.text);
            if (Buffer.byteLength(markdown, 'utf8') > limits.maxSpecBytes) {
              throw new StepError(`The draft is larger than ${limits.maxSpecBytes} bytes.`, {
                code: 'SPEC_TOO_LARGE',
              });
            }
            return {
              type: 'SPEC_GENERATED',
              markdown,
              agent: {
                id: codingAgent.id,
                displayName: codingAgent.displayName,
                costUsd: result.costUsd,
              },
            };
          }),
      },
      VALIDATE_SPEC: {
        kind: 'step',
        title: 'Check draft',
        run: ({ context }): Promise<Event> => {
          const check = checkSpec(
            requireValue(context.markdown, 'draft'),
            context.files.map((file) => file.path),
          );
          return Promise.resolve(
            check.problems.length === 0
              ? { type: 'SPEC_VALID', warnings: check.warnings }
              : { type: 'SPEC_INVALID', problems: check.problems },
          );
        },
      },
      AWAIT_REVIEW: {
        kind: 'approval',
        title: 'Review draft spec',
        approvalType: 'spec-review',
        request: (context) => ({
          title: context.title,
          markdown: context.markdown,
          warnings: context.warnings,
          source: context.sourceRoot,
          filesAnalysed: context.files.length,
          generatedBy: context.agent?.displayName ?? null,
          note: 'Approve to save the spec in the output directory. Reject to discard it.',
        }),
      },
      EXPORT_RESULT: {
        kind: 'step',
        title: 'Save spec',
        run: ({ context, executionId }): Promise<Event> =>
          guarded(async () => {
            const title = requireValue(context.title, 'title');
            const markdown = requireValue(context.markdown, 'draft');
            const header = [
              '---',
              `title: ${JSON.stringify(title)}`,
              `source: ${JSON.stringify(context.sourceRoot)}`,
              `generated_by: ${JSON.stringify(context.agent?.displayName ?? 'unknown')}`,
              `execution: ${executionId}`,
              `review_feedback: ${JSON.stringify(context.reviewFeedback)}`,
              '---',
              '',
            ].join('\n');
            const content = `${header}${markdown}\n`;
            // One file per execution, overwritten on a re-run: saving twice gives the same file.
            const path = await filesystem.writeTextFile(
              requireValue(context.outputRoot, 'output'),
              `${slug(title)}-${executionId.slice(0, 8)}.md`,
              content,
              { overwrite: true },
            );
            return { type: 'EXPORTED', path, bytes: Buffer.byteLength(content, 'utf8') };
          }),
      },
      DONE: { kind: 'final', title: 'Saved', status: 'COMPLETED' },
      REJECTED: { kind: 'final', title: 'Rejected', status: 'CANCELLED' },
      INVALID_SPEC: {
        kind: 'final',
        title: 'Draft failed checks',
        status: 'FAILED',
        errorCode: 'SPEC_INVALID',
        errorMessage: 'The generated drafts did not pass the automatic checks.',
      },
    },
  });
}
