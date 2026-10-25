import { z } from 'zod';
import { resolveExecutable, type ResolvedCommand } from '../process/resolve-executable.js';
import { ProcessSpawnError, runProcess } from '../process/run-process.js';
import {
  CodingAgentError,
  type CodingAgent,
  type CodingAgentInfo,
  type CodingAgentRequest,
  type CodingAgentResult,
} from './coding-agent.js';

export interface ClaudeCodeAgentOptions {
  /** Path or name of the CLI. Default `claude`, found on PATH. */
  executable?: string;
  /** Extra leading arguments, e.g. a script path when `executable` is node. */
  prefixArgs?: readonly string[];
  model?: string;
  /** Passed as --max-budget-usd: the CLI stops when a run would cost more. */
  maxBudgetUsd?: number;
  /** Base environment for the CLI; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
}

/** The fields of `claude -p --output-format json` this adapter relies on (checked on 2.1.296). */
const resultSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string().optional(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
    session_id: z.string().optional(),
    api_error_status: z.number().nullable().optional(),
  })
  .loose();

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Variables never passed to the CLI: the platform's own secret, the UI build settings, and
 * markers that make Claude Code think it runs nested inside another session.
 */
const STRIPPED_ENV = [/^AAP_/, /^NEXT_PUBLIC_/, /^CLAUDECODE$/, /^CLAUDE_CODE_ENTRYPOINT$/];

function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(([key]) => !STRIPPED_ENV.some((pattern) => pattern.test(key))),
  );
}

function firstLine(text: string, max = 500): string {
  const line =
    text
      .trim()
      .split(/\r?\n/)
      .find((l) => l.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Claude Code CLI in non-interactive print mode. Every run is read-only and restricted:
 * - `--tools Read,Grep,Glob`: no edit, write, shell or web tools exist in the session.
 * - `--restricted`: file tools stay inside the working directory; user and project settings
 *   (hooks, permissions) are ignored, so a repository cannot widen what the agent may do.
 * - `--permission-prompts none`: anything that would ask for permission is denied.
 * - `--strict-mcp-config` with no config: no MCP servers.
 * - `--no-session-persistence`: no transcript is kept on disk.
 * The prompt goes over stdin, never through a shell.
 */
export class ClaudeCodeAgent implements CodingAgent {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code CLI';
  readonly #options: ClaudeCodeAgentOptions;

  constructor(options: ClaudeCodeAgentOptions = {}) {
    this.#options = options;
  }

  #command(): ResolvedCommand | null {
    const name = this.#options.executable ?? 'claude';
    if (this.#options.prefixArgs !== undefined) {
      return { executable: name, prefixArgs: [...this.#options.prefixArgs] };
    }
    return resolveExecutable(name, this.#options.env ?? process.env);
  }

  #dataNotice(): string {
    return (
      'Sends the files it reads from the selected source folder, and the prompt, to ' +
      'Anthropic through your Claude Code login. Use it only on code your company allows ' +
      'you to share.'
    );
  }

  async probe(): Promise<CodingAgentInfo> {
    const base = {
      id: this.id,
      displayName: this.displayName,
      dataNotice: this.#dataNotice(),
    };
    const command = this.#command();
    if (command === null) {
      return {
        ...base,
        available: false,
        version: null,
        reason: 'Claude Code CLI not found on PATH. Install it, or set AAP_CLAUDE_EXECUTABLE.',
      };
    }
    try {
      const result = await runProcess({
        executable: command.executable,
        args: [...command.prefixArgs, '--version'],
        cwd: process.cwd(),
        env: childEnv(this.#options.env ?? process.env),
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0) {
        return {
          ...base,
          available: false,
          version: null,
          reason: `"claude --version" failed: ${firstLine(result.stderr || result.stdout) || `exit ${String(result.exitCode)}`}`,
        };
      }
      return { ...base, available: true, version: firstLine(result.stdout, 80), reason: null };
    } catch (error) {
      return {
        ...base,
        available: false,
        version: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(request: CodingAgentRequest): Promise<CodingAgentResult> {
    const command = this.#command();
    if (command === null) {
      throw new CodingAgentError('AGENT_UNAVAILABLE', 'Claude Code CLI not found.', false);
    }
    const args = [
      ...command.prefixArgs,
      '-p',
      '--output-format',
      'json',
      '--tools',
      'Read,Grep,Glob',
      '--restricted',
      '--permission-prompts',
      'none',
      '--strict-mcp-config',
      '--no-session-persistence',
      ...(this.#options.model === undefined ? [] : ['--model', this.#options.model]),
      ...(this.#options.maxBudgetUsd === undefined
        ? []
        : ['--max-budget-usd', String(this.#options.maxBudgetUsd)]),
    ];

    let result;
    try {
      result = await runProcess({
        executable: command.executable,
        args,
        cwd: request.workingDirectory,
        env: childEnv(this.#options.env ?? process.env),
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      if (error instanceof ProcessSpawnError) {
        throw new CodingAgentError('AGENT_UNAVAILABLE', error.message, false, { cause: error });
      }
      throw error;
    }

    if (result.aborted) {
      throw new CodingAgentError('AGENT_CANCELLED', 'The Claude Code run was stopped.', false);
    }
    if (result.timedOut) {
      throw new CodingAgentError(
        'AGENT_TIMEOUT',
        `Claude Code did not finish within ${request.timeoutMs} ms and was stopped.`,
        false,
      );
    }
    if (result.stdoutTruncated) {
      throw new CodingAgentError(
        'AGENT_OUTPUT_INVALID',
        'Claude Code output was too large.',
        false,
      );
    }

    let parsed: z.infer<typeof resultSchema>;
    try {
      parsed = resultSchema.parse(JSON.parse(result.stdout.trim()));
    } catch (cause) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout);
      throw new CodingAgentError(
        result.exitCode === 0 ? 'AGENT_OUTPUT_INVALID' : 'AGENT_FAILED',
        `Claude Code returned unexpected output (exit ${String(result.exitCode)})${detail === '' ? '' : `: ${detail}`}`,
        false,
        { cause },
      );
    }

    if (parsed.is_error || parsed.subtype !== 'success' || result.exitCode !== 0) {
      const detail = firstLine(parsed.result ?? result.stderr) || parsed.subtype;
      const status = parsed.api_error_status ?? null;
      if (status === 429 || status === 529 || /rate.?limit|overloaded/i.test(detail)) {
        throw new CodingAgentError(
          'AGENT_RATE_LIMITED',
          `Claude Code is rate limited: ${detail}`,
          true,
        );
      }
      if (/budget/i.test(parsed.subtype)) {
        throw new CodingAgentError(
          'AGENT_BUDGET_EXCEEDED',
          `The run reached its budget limit (${String(this.#options.maxBudgetUsd)} USD).`,
          false,
        );
      }
      throw new CodingAgentError('AGENT_FAILED', `Claude Code failed: ${detail}`, false);
    }

    return {
      text: parsed.result ?? '',
      costUsd: parsed.total_cost_usd ?? null,
      turns: parsed.num_turns ?? null,
      durationMs: result.durationMs,
      sessionId: parsed.session_id ?? null,
    };
  }
}
