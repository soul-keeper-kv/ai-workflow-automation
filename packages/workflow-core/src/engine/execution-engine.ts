import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  ApprovalNotFoundError,
  ENGINE_ERROR_CODES,
  ExecutionConflictError,
  ExecutionNotFoundError,
  StepError,
  StepTimeoutError,
  WorkflowEngineError,
} from '../contracts/errors.js';
import type { JsonValue } from '../contracts/json.js';
import { silentLogger, type Logger } from '../contracts/logger.js';
import type {
  ApprovalDecision,
  ResolvedStepPolicy,
  TransitionOutcome,
  Workflow,
} from '../contracts/workflow.js';
import { isTerminalStatus } from '../execution/status.js';
import type {
  ErrorInfo,
  ExecutionChange,
  ExecutionRecord,
  ExecutionStore,
  NewExecutionEvent,
} from '../persistence/execution-store.js';
import { planRecovery } from '../recovery/plan-recovery.js';
import type { WorkflowRegistry } from '../registry/workflow-registry.js';

export interface ExecutionEngineOptions {
  registry: WorkflowRegistry;
  store: ExecutionStore;
  logger?: Logger;
  /** Executions that run at the same time. The rest wait in FIFO order. */
  maxConcurrentExecutions?: number;
  generateId?: () => string;
  /** After a step times out and is aborted, how long it gets to stop before it is abandoned. */
  abortGraceMs?: number;
}

export interface StopOptions {
  /** How long running steps get to finish on their own. */
  drainTimeoutMs?: number;
  /** After aborting, how long to wait for steps to react before giving up. */
  abortTimeoutMs?: number;
}

export interface RecoveryReport {
  resumed: string[];
  /** Steps marked safe to re-run that were running when the app stopped. */
  rerun: string[];
  interrupted: string[];
}

export interface CancelResult {
  /**
   * `cancelled`: the execution is CANCELLED now.
   * `requested`: a step is running; it was asked to stop, and the execution becomes CANCELLED
   * when it does.
   */
  outcome: 'cancelled' | 'requested';
  execution: ExecutionRecord;
}

/** The abort reason given to steps when the engine stops. */
export class EngineShutdownError extends Error {
  override readonly name = 'EngineShutdownError';

  constructor() {
    super('The workflow engine is shutting down.');
  }
}

/** The abort reason given to a step when the user cancels its execution. */
export class ExecutionCancelledError extends Error {
  override readonly name = 'ExecutionCancelledError';

  constructor() {
    super('The execution was cancelled.');
  }
}

interface ActiveExecution {
  controller: AbortController;
  done: Promise<void>;
}

type AttemptResult =
  | { ok: true; outcome: TransitionOutcome }
  | { ok: false; reason: 'cancelled' | 'shutdown' | 'timeout' | 'error'; error: unknown };

const DEFAULT_ABORT_GRACE_MS = 5_000;

const CANCELLED_WHILE_RUNNING: ErrorInfo = {
  code: ENGINE_ERROR_CODES.cancelled,
  message: 'Cancelled while this step was running.',
};

function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof WorkflowEngineError) return { code: error.code, message: error.message };
  if (error instanceof Error)
    return { code: ENGINE_ERROR_CODES.stepFailed, message: error.message };
  return { code: ENGINE_ERROR_CODES.stepFailed, message: String(error) };
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs executions inside this process: one step at a time per execution, persisting every
 * step start and every transition before moving on. HTTP handlers call `start`, `cancel`,
 * `decide` or `resume` and return; the work happens here, outside the request.
 *
 * While a step runs, only that execution's run loop writes to it. Requests that arrive
 * meanwhile (cancel) set a flag and abort the step's signal; the loop records the outcome.
 * Executions that wait for approval have no run loop at all, so a decision is applied
 * directly.
 */
export class ExecutionEngine {
  readonly #registry: WorkflowRegistry;
  readonly #store: ExecutionStore;
  readonly #log: Logger;
  readonly #maxConcurrent: number;
  readonly #generateId: () => string;
  readonly #abortGraceMs: number;

  readonly #queue: string[] = [];
  readonly #active = new Map<string, ActiveExecution>();
  readonly #cancelRequested = new Set<string>();
  readonly #idleWaiters: (() => void)[] = [];
  #stopping = false;

  constructor(options: ExecutionEngineOptions) {
    this.#registry = options.registry;
    this.#store = options.store;
    this.#log = options.logger ?? silentLogger;
    this.#maxConcurrent = Math.max(1, options.maxConcurrentExecutions ?? 2);
    this.#generateId = options.generateId ?? randomUUID;
    this.#abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  }

  /**
   * Validates input, persists a PENDING execution and schedules it. Returns without waiting
   * for any step. Throws WorkflowNotFoundError or InputValidationError.
   */
  start(workflowId: string, rawInput: unknown): ExecutionRecord {
    this.#assertRunning();
    const workflow = this.#registry.require(workflowId);
    const prepared = workflow.prepare(rawInput);
    const execution = this.#store.createExecution({
      id: this.#generateId(),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      currentState: prepared.state,
      input: prepared.input,
      context: prepared.context,
    });
    this.#log.info(
      { executionId: execution.id, workflowId, eventType: 'EXECUTION_CREATED' },
      'Execution created',
    );
    this.#schedule(execution.id);
    return execution;
  }

  /**
   * Cancels cooperatively. No new step starts; a running step gets its signal aborted and the
   * execution becomes CANCELLED once the step settles. A pending approval is closed. History
   * is kept. Throws ExecutionNotFoundError, or ExecutionConflictError for a finished execution.
   */
  cancel(executionId: string): CancelResult {
    const execution = this.#requireExecution(executionId);
    if (isTerminalStatus(execution.status)) {
      throw new ExecutionConflictError(
        executionId,
        `The execution is already ${execution.status} and cannot be cancelled.`,
      );
    }

    const active = this.#active.get(executionId);
    if (active !== undefined) {
      if (!this.#cancelRequested.has(executionId)) {
        this.#cancelRequested.add(executionId);
        active.controller.abort(new ExecutionCancelledError());
        this.#log.info({ executionId, eventType: 'CANCEL_REQUESTED' }, 'Cancel requested');
      }
      return { outcome: 'requested', execution };
    }

    // Nothing runs for it in this process, so it can be cancelled right away.
    const queued = this.#queue.indexOf(executionId);
    if (queued >= 0) this.#queue.splice(queued, 1);
    const cancelled = this.#store.applyChange({
      executionId,
      expectedRevision: execution.revision,
      execution: { status: 'CANCELLED' },
      events: [{ type: 'CANCEL_REQUESTED', stateBefore: execution.currentState }],
    });
    this.#log.info({ executionId, eventType: 'CANCEL_REQUESTED' }, 'Execution cancelled');
    return { outcome: 'cancelled', execution: cancelled };
  }

  isCancelRequested(executionId: string): boolean {
    return this.#cancelRequested.has(executionId);
  }

  /**
   * Applies a person's decision to the pending approval. Rejected unless the execution is
   * WAITING_FOR_APPROVAL, the approval is the pending one, and the machine accepts the event.
   */
  decide(
    executionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    feedback: string | null,
  ): ExecutionRecord {
    this.#assertRunning();
    const execution = this.#requireExecution(executionId);
    const approval = this.#store.getApproval(approvalId);
    if (approval?.executionId !== executionId) {
      throw new ApprovalNotFoundError(executionId, approvalId);
    }
    if (execution.status !== 'WAITING_FOR_APPROVAL') {
      throw new ExecutionConflictError(
        executionId,
        `The execution is ${execution.status}, not waiting for approval.`,
      );
    }
    if (approval.status !== 'PENDING' || approval.state !== execution.currentState) {
      throw new ExecutionConflictError(
        executionId,
        `Approval ${approvalId} is ${approval.status} and cannot be decided now.`,
      );
    }
    const workflow = this.#requireRegisteredWorkflow(execution);

    const outcome = workflow.decide({
      state: execution.currentState,
      context: execution.context,
      decision,
      feedback,
    });
    const status =
      outcome.final?.status ?? (outcome.approval === null ? 'RUNNING' : 'WAITING_FOR_APPROVAL');
    const decisionPayload: JsonValue = { decision, feedback };
    const approvalParts = this.#approvalParts(outcome);
    const updated = this.#store.applyChange({
      executionId,
      expectedRevision: execution.revision,
      decideApproval: { id: approvalId, status: decision, decision: decisionPayload },
      ...approvalParts.change,
      execution: {
        status,
        currentState: outcome.stateAfter,
        context: outcome.context,
        ...(outcome.final === null
          ? {}
          : {
              output: outcome.final.output,
              ...(outcome.final.error === null ? {} : { error: outcome.final.error }),
            }),
      },
      events: [
        {
          type: 'APPROVAL_DECIDED',
          stateBefore: execution.currentState,
          payload: { approvalId, decision },
        },
        {
          type: 'STATE_CHANGED',
          stateBefore: execution.currentState,
          stateAfter: outcome.stateAfter,
          payload: { event: outcome.eventType },
        },
        ...approvalParts.events,
      ],
    });
    this.#log.info(
      { executionId, workflowId: workflow.id, eventType: 'APPROVAL_DECIDED', decision },
      'Approval decided',
    );
    if (status === 'RUNNING') this.#schedule(executionId);
    return updated;
  }

  /**
   * Continues an INTERRUPTED execution by running its current step again, as a new attempt.
   * Only a person calls this: the step may repeat side effects of the interrupted attempt.
   */
  resume(executionId: string): ExecutionRecord {
    this.#assertRunning();
    const execution = this.#requireExecution(executionId);
    if (execution.status !== 'INTERRUPTED') {
      throw new ExecutionConflictError(
        executionId,
        `Only INTERRUPTED executions can be resumed; this one is ${execution.status}.`,
      );
    }
    const workflow = this.#requireRegisteredWorkflow(execution);
    if (workflow.getState(execution.currentState)?.kind !== 'step') {
      throw new ExecutionConflictError(
        executionId,
        `State "${execution.currentState}" is not a step and cannot be re-run.`,
      );
    }
    const resumed = this.#store.applyChange({
      executionId,
      expectedRevision: execution.revision,
      execution: { status: 'RUNNING', error: null },
      events: [{ type: 'EXECUTION_RESUMED', stateBefore: execution.currentState }],
    });
    this.#log.info({ executionId, eventType: 'EXECUTION_RESUMED' }, 'Execution resumed');
    this.#schedule(executionId);
    return resumed;
  }

  /** Call once at startup, before accepting work. See planRecovery for the rules. */
  recover(): RecoveryReport {
    const report: RecoveryReport = { resumed: [], rerun: [], interrupted: [] };
    for (const execution of this.#store.listExecutionsByStatus(['PENDING', 'RUNNING'])) {
      const runningStep = this.#store.getRunningStepRun(execution.id) ?? null;
      const workflow = this.#registry.get(execution.workflowId);
      const recovery =
        runningStep !== null && workflow?.version === execution.workflowVersion
          ? workflow.stepPolicy(runningStep.stepId).recovery
          : null;
      const plan = planRecovery(execution, runningStep, recovery);

      if (plan.action === 'resume') {
        report.resumed.push(execution.id);
      } else if (plan.action === 'rerun' && runningStep !== null) {
        this.#store.applyChange({
          executionId: execution.id,
          expectedRevision: execution.revision,
          finishStepRun: { id: runningStep.id, status: 'INTERRUPTED', error: plan.note },
          events: [this.#stepEvent('STEP_INTERRUPTED', runningStep.stepId, runningStep.id)],
        });
        report.rerun.push(execution.id);
      } else if (plan.action === 'interrupt') {
        this.#store.applyChange({
          executionId: execution.id,
          expectedRevision: execution.revision,
          execution: { status: 'INTERRUPTED', error: plan.error },
          ...(runningStep === null
            ? {}
            : {
                finishStepRun: { id: runningStep.id, status: 'INTERRUPTED', error: plan.error },
                events: [this.#stepEvent('STEP_INTERRUPTED', runningStep.stepId, runningStep.id)],
              }),
        });
        report.interrupted.push(execution.id);
        continue;
      }
      this.#schedule(execution.id);
    }
    this.#log.info(
      {
        resumed: report.resumed.length,
        rerun: report.rerun.length,
        interrupted: report.interrupted.length,
      },
      'Recovery finished',
    );
    return report;
  }

  /**
   * Stops scheduling, lets running steps finish for `drainTimeoutMs`, then aborts them.
   * A step that finishes during the drain commits normally, so its execution resumes on the
   * next start. A step that is aborted leaves its execution INTERRUPTED.
   */
  async stop(options: StopOptions = {}): Promise<void> {
    const { drainTimeoutMs = 5_000, abortTimeoutMs = 2_000 } = options;
    this.#stopping = true;
    this.#queue.length = 0;

    if (await this.#settleWithin(drainTimeoutMs)) return;

    this.#log.warn({ executionIds: [...this.#active.keys()] }, 'Aborting steps still running');
    for (const { controller } of this.#active.values()) controller.abort(new EngineShutdownError());

    if (!(await this.#settleWithin(abortTimeoutMs))) {
      this.#log.error(
        { executionIds: [...this.#active.keys()] },
        'Steps ignored the abort; they will be marked interrupted on the next start',
      );
    }
  }

  /** Resolves when nothing is running or queued. */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  isActive(executionId: string): boolean {
    return this.#active.has(executionId) || this.#queue.includes(executionId);
  }

  #assertRunning(): void {
    if (this.#stopping) {
      throw new WorkflowEngineError('ENGINE_STOPPING', 'The workflow engine is shutting down.');
    }
  }

  #requireExecution(executionId: string): ExecutionRecord {
    const execution = this.#store.getExecution(executionId);
    if (execution === undefined) throw new ExecutionNotFoundError(executionId);
    return execution;
  }

  #requireRegisteredWorkflow(execution: ExecutionRecord): Workflow {
    const workflow = this.#registry.get(execution.workflowId);
    if (workflow?.version !== execution.workflowVersion) {
      throw new ExecutionConflictError(
        execution.id,
        `Workflow ${execution.workflowId}@${execution.workflowVersion} is not registered in this version of the app.`,
      );
    }
    return workflow;
  }

  #isIdle(): boolean {
    return this.#active.size === 0 && this.#queue.length === 0;
  }

  #schedule(executionId: string): void {
    if (this.#stopping || this.isActive(executionId)) return;
    this.#queue.push(executionId);
    this.#pump();
  }

  #pump(): void {
    while (!this.#stopping && this.#active.size < this.#maxConcurrent) {
      const executionId = this.#queue.shift();
      if (executionId === undefined) break;

      const controller = new AbortController();
      const done = this.#runExecution(executionId, controller.signal)
        .catch((error: unknown) => {
          this.#log.error({ executionId, err: error }, 'Execution loop stopped on an error');
        })
        .finally(() => {
          this.#active.delete(executionId);
          this.#cancelRequested.delete(executionId);
          this.#pump();
          if (this.#isIdle()) for (const resolve of this.#idleWaiters.splice(0)) resolve();
        });
      this.#active.set(executionId, { controller, done });
    }
  }

  async #settleWithin(timeoutMs: number): Promise<boolean> {
    if (this.#active.size === 0) return true;
    const all = Promise.allSettled([...this.#active.values()].map((active) => active.done));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([all.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #runExecution(executionId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (this.#stopping) return;

      const execution = this.#store.getExecution(executionId);
      if (execution === undefined) return;
      if (execution.status !== 'PENDING' && execution.status !== 'RUNNING') return;

      if (this.#cancelRequested.has(executionId)) {
        this.#cancelBetweenSteps(execution);
        return;
      }

      const workflow = this.#registry.get(execution.workflowId);
      if (workflow?.version !== execution.workflowVersion) {
        this.#store.applyChange({
          executionId,
          expectedRevision: execution.revision,
          execution: {
            status: 'INTERRUPTED',
            error: {
              code: ENGINE_ERROR_CODES.workflowUnavailable,
              message: `Workflow ${execution.workflowId}@${execution.workflowVersion} is not registered in this version of the app.`,
            },
          },
        });
        return;
      }

      if (workflow.getState(execution.currentState)?.kind !== 'step') {
        this.#store.applyChange({
          executionId,
          expectedRevision: execution.revision,
          execution: {
            status: 'FAILED',
            error: {
              code: ENGINE_ERROR_CODES.invalidState,
              message: `State "${execution.currentState}" has no step to run.`,
            },
          },
        });
        return;
      }

      const finished = await this.#runStep(workflow, execution, signal);
      if (finished) return;
    }
  }

  #cancelBetweenSteps(execution: ExecutionRecord): void {
    this.#store.applyChange({
      executionId: execution.id,
      expectedRevision: execution.revision,
      execution: { status: 'CANCELLED' },
      events: [{ type: 'CANCEL_REQUESTED', stateBefore: execution.currentState }],
    });
  }

  /**
   * Runs the step of the execution's current state, retrying as its policy allows.
   * Returns true when the run loop must end.
   */
  async #runStep(
    workflow: Workflow,
    execution: ExecutionRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    const stepId = execution.currentState;
    const policy = workflow.stepPolicy(stepId);
    let current = execution;

    for (;;) {
      const attempt = this.#store.countStepRuns(current.id, stepId) + 1;
      const stepRunId = this.#generateId();
      const log = this.#log.child({
        executionId: current.id,
        workflowId: workflow.id,
        stepId,
        attempt,
      });

      const started = this.#store.applyChange({
        executionId: current.id,
        expectedRevision: current.revision,
        execution: { status: 'RUNNING' },
        startStepRun: { id: stepRunId, stepId, attempt },
        events: [this.#stepEvent('STEP_STARTED', stepId, stepRunId, { attempt })],
      });
      log.info({ eventType: 'STEP_STARTED' }, 'Step started');
      const startTime = performance.now();
      const elapsed = () => Math.round(performance.now() - startTime);

      const result = await this.#attempt(workflow, started, attempt, policy, signal, log);
      if (result.ok) {
        const stop = this.#commitSuccess(started, stepRunId, attempt, result.outcome);
        log.info(
          {
            eventType: 'STEP_SUCCEEDED',
            durationMs: elapsed(),
            result: 'succeeded',
            nextState: result.outcome.stateAfter,
          },
          'Step succeeded',
        );
        return stop;
      }

      const retryDelay = this.#retryDelay(result, policy, current.id, stepId);
      const info = this.#failureInfo(result, stepId);
      const status =
        result.reason === 'cancelled'
          ? 'CANCELLED'
          : result.reason === 'shutdown'
            ? 'INTERRUPTED'
            : retryDelay === null
              ? 'FAILED'
              : 'RUNNING';
      const stepStatus =
        result.reason === 'cancelled' || result.reason === 'shutdown' ? 'INTERRUPTED' : 'FAILED';
      const events: NewExecutionEvent[] = [];
      if (result.reason === 'cancelled')
        events.push({ type: 'CANCEL_REQUESTED', stateBefore: stepId });
      events.push(
        this.#stepEvent(
          stepStatus === 'FAILED' ? 'STEP_FAILED' : 'STEP_INTERRUPTED',
          stepId,
          stepRunId,
          {
            attempt,
            errorCode: info.code,
          },
        ),
      );
      if (retryDelay !== null) {
        events.push(
          this.#stepEvent('STEP_RETRY_SCHEDULED', stepId, stepRunId, {
            attempt,
            delayMs: retryDelay,
          }),
        );
      }

      current = this.#store.applyChange({
        executionId: current.id,
        expectedRevision: started.revision,
        execution:
          status === 'RUNNING' || status === 'CANCELLED' ? { status } : { status, error: info },
        finishStepRun: { id: stepRunId, status: stepStatus, error: info },
        events,
      });
      const outcome = retryDelay === null ? result.reason : 'retrying';
      log[outcome === 'error' || outcome === 'timeout' ? 'error' : 'warn'](
        {
          eventType: events.at(-1)?.type,
          durationMs: elapsed(),
          result: outcome,
          errorCode: info.code,
          ...(result.reason === 'error' ? { err: result.error } : {}),
          ...(retryDelay === null ? {} : { retryInMs: retryDelay }),
        },
        retryDelay === null ? `Step ${result.reason}` : 'Step failed; retrying',
      );
      if (retryDelay === null) return true;

      // Wait for the retry. A cancel or shutdown cuts the wait short; nothing is running then,
      // so a shutdown leaves the execution between steps and it resumes on the next start.
      const waited = await sleep(retryDelay, signal);
      if (!waited || this.#stopping) {
        if (this.#cancelRequested.has(current.id)) this.#cancelBetweenSteps(current);
        return true;
      }
    }
  }

  /** One attempt, bounded by the step's timeout. Never throws. */
  async #attempt(
    workflow: Workflow,
    execution: ExecutionRecord,
    attempt: number,
    policy: ResolvedStepPolicy,
    signal: AbortSignal,
    log: Logger,
  ): Promise<AttemptResult> {
    const controller = new AbortController();
    const forward = () => controller.abort(signal.reason);
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });

    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    const run = workflow.runStep({
      state: execution.currentState,
      context: execution.context,
      executionId: execution.id,
      attempt,
      signal: controller.signal,
      log,
    });
    // If the step is abandoned after a timeout, its eventual rejection must not go unhandled.
    run.catch(() => undefined);

    try {
      if (policy.timeoutMs === null) return { ok: true, outcome: await run };

      const timeoutMs = policy.timeoutMs;
      timers.push(
        setTimeout(() => {
          timedOut = true;
          controller.abort(new StepTimeoutError(timeoutMs, true));
        }, timeoutMs),
      );
      const abandoned = new Promise<'abandoned'>((resolve) => {
        timers.push(setTimeout(() => resolve('abandoned'), timeoutMs + this.#abortGraceMs));
      });
      const settled = await Promise.race([run.then((outcome) => ({ outcome })), abandoned]);
      if (settled === 'abandoned') {
        return { ok: false, reason: 'timeout', error: new StepTimeoutError(timeoutMs, false) };
      }
      return { ok: true, outcome: settled.outcome };
    } catch (error) {
      if (this.#cancelRequested.has(execution.id)) return { ok: false, reason: 'cancelled', error };
      if (signal.aborted) return { ok: false, reason: 'shutdown', error };
      if (timedOut) {
        return {
          ok: false,
          reason: 'timeout',
          error: new StepTimeoutError(policy.timeoutMs ?? 0, true),
        };
      }
      return { ok: false, reason: 'error', error };
    } finally {
      for (const timer of timers) clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    }
  }

  /** Milliseconds until the next attempt, or null when this failure is final. */
  #retryDelay(
    result: Extract<AttemptResult, { ok: false }>,
    policy: ResolvedStepPolicy,
    executionId: string,
    stepId: string,
  ): number | null {
    const retryable =
      (result.reason === 'error' && result.error instanceof StepError && result.error.retryable) ||
      (result.reason === 'timeout' &&
        policy.retry.retryOnTimeout &&
        result.error instanceof StepTimeoutError &&
        result.error.stopped);
    if (!retryable) return null;

    // Consecutive failed attempts of this step, counting the one that just failed.
    let failures = 1;
    for (const run of this.#store.listStepRuns(executionId).reverse()) {
      if (run.status === 'RUNNING') continue;
      if (run.stepId !== stepId || run.status !== 'FAILED') break;
      failures += 1;
    }
    if (failures >= policy.retry.maxAttempts) return null;
    const { initialDelayMs, multiplier, maxDelayMs } = policy.retry;
    return Math.min(maxDelayMs, Math.round(initialDelayMs * multiplier ** (failures - 1)));
  }

  #failureInfo(result: Extract<AttemptResult, { ok: false }>, stepId: string): ErrorInfo {
    switch (result.reason) {
      case 'cancelled':
        return CANCELLED_WHILE_RUNNING;
      case 'shutdown':
        return {
          code: ENGINE_ERROR_CODES.interrupted,
          message: `The app stopped while step "${stepId}" was running. It was not re-run, because it may already have had side effects.`,
        };
      default:
        return errorInfo(result.error);
    }
  }

  /** Persists a successful step and its transition. Returns true when the run loop must end. */
  #commitSuccess(
    execution: ExecutionRecord,
    stepRunId: string,
    attempt: number,
    outcome: TransitionOutcome,
  ): boolean {
    const stepId = execution.currentState;
    // A cancel that arrived while the step ran wins, unless the step already ended the run.
    const cancelled = outcome.final === null && this.#cancelRequested.has(execution.id);
    const waiting = !cancelled && outcome.approval !== null;
    const approvalParts = waiting ? this.#approvalParts(outcome) : { change: {}, events: [] };
    const change: ExecutionChange = {
      executionId: execution.id,
      expectedRevision: execution.revision,
      execution: {
        currentState: outcome.stateAfter,
        context: outcome.context,
        ...(outcome.final === null
          ? {}
          : {
              status: outcome.final.status,
              output: outcome.final.output,
              ...(outcome.final.error === null ? {} : { error: outcome.final.error }),
            }),
        ...(cancelled ? { status: 'CANCELLED' } : {}),
        ...(waiting ? { status: 'WAITING_FOR_APPROVAL' } : {}),
      },
      finishStepRun: { id: stepRunId, status: 'SUCCEEDED', output: outcome.event },
      ...approvalParts.change,
      events: [
        this.#stepEvent('STEP_SUCCEEDED', stepId, stepRunId, { attempt, event: outcome.eventType }),
        {
          type: 'STATE_CHANGED',
          stateBefore: stepId,
          stateAfter: outcome.stateAfter,
          payload: { event: outcome.eventType },
        },
        ...approvalParts.events,
        ...(cancelled
          ? [{ type: 'CANCEL_REQUESTED' as const, stateBefore: outcome.stateAfter }]
          : []),
      ],
    };
    this.#store.applyChange(change);
    return outcome.final !== null || cancelled || waiting;
  }

  /** The approval request to open for an outcome, and the event that records it. */
  #approvalParts(outcome: TransitionOutcome): {
    change: Pick<ExecutionChange, 'requestApproval'>;
    events: NewExecutionEvent[];
  } {
    if (outcome.approval === null) return { change: {}, events: [] };
    const id = this.#generateId();
    const { approvalType, request } = outcome.approval;
    return {
      change: { requestApproval: { id, state: outcome.stateAfter, approvalType, request } },
      events: [
        {
          type: 'APPROVAL_REQUESTED',
          stateAfter: outcome.stateAfter,
          payload: { approvalId: id, approvalType },
        },
      ],
    };
  }

  #stepEvent(
    type:
      | 'STEP_STARTED'
      | 'STEP_SUCCEEDED'
      | 'STEP_FAILED'
      | 'STEP_INTERRUPTED'
      | 'STEP_RETRY_SCHEDULED',
    stepId: string,
    stepRunId: string,
    extra: Record<string, JsonValue> = {},
  ): NewExecutionEvent {
    return { type, stateBefore: stepId, payload: { stepRunId, stepId, ...extra } };
  }
}
