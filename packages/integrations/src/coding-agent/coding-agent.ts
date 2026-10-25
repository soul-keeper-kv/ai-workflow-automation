/**
 * A coding agent the platform can delegate work to. The workflow engine and workflow
 * definitions only see this interface, never a particular CLI or its output format
 * (blueprint §10).
 */
export interface CodingAgent {
  readonly id: string;
  readonly displayName: string;
  /** Checks that the agent can run here. Cheap; called at startup. */
  probe(): Promise<CodingAgentInfo>;
  execute(request: CodingAgentRequest): Promise<CodingAgentResult>;
}

export interface CodingAgentInfo {
  id: string;
  displayName: string;
  available: boolean;
  version: string | null;
  /** Why the agent is unavailable, when it is. */
  reason: string | null;
  /** Shown to the user: where their code goes when this agent runs. */
  dataNotice: string;
}

export interface CodingAgentRequest {
  /** The agent works here; its file tools cannot reach outside it. */
  workingDirectory: string;
  prompt: string;
  /**
   * `read-only` is the only mode so far: the agent may read and search, never edit or run
   * commands. Editing modes will need an isolated Git worktree and an approval first.
   */
  mode: 'read-only';
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CodingAgentResult {
  text: string;
  costUsd: number | null;
  turns: number | null;
  durationMs: number;
  sessionId: string | null;
}

export type CodingAgentErrorCode =
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_TIMEOUT'
  | 'AGENT_CANCELLED'
  | 'AGENT_RATE_LIMITED'
  | 'AGENT_BUDGET_EXCEEDED'
  | 'AGENT_OUTPUT_INVALID'
  | 'AGENT_FAILED';

export class CodingAgentError extends Error {
  override readonly name = 'CodingAgentError';

  constructor(
    readonly code: CodingAgentErrorCode,
    message: string,
    /** True only for failures a later attempt can fix, such as rate limits. */
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
