import {
  apiErrorResponseSchema,
  cancelExecutionResponseSchema,
  executionResponseSchema,
  executionStatsResponseSchema,
  listEventsResponseSchema,
  listExecutionsResponseSchema,
  listWorkflowsResponseSchema,
} from '@aap/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { AUTH, testConfig } from './helpers.js';

let app: App;
let config: ReturnType<typeof testConfig>;

beforeEach(async () => {
  config = testConfig();
  app = await buildApp(config);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  config.cleanup();
});

const errorCode = (body: unknown) => apiErrorResponseSchema.parse(body).error.code;

async function startDemo(
  input: unknown = { items: ['a', 'b'], stepDelayMs: 0, requireReview: false },
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/executions',
    headers: AUTH,
    payload: { workflowId: 'demo-sequence', input },
  });
  expect(response.statusCode).toBe(201);
  return executionResponseSchema.parse(response.json()).execution;
}

async function getExecution(id: string) {
  const response = await app.inject({ url: `/api/executions/${id}`, headers: AUTH });
  return executionResponseSchema.parse(response.json()).execution;
}

describe('local API security', () => {
  it('rejects /api requests without the token, or with a wrong one', async () => {
    const none = await app.inject({ url: '/api/workflows' });
    const wrong = await app.inject({
      url: '/api/workflows',
      headers: { authorization: 'Bearer nope' },
    });

    expect(none.statusCode).toBe(401);
    expect(errorCode(none.json())).toBe('UNAUTHORIZED');
    expect(wrong.statusCode).toBe(401);
  });

  it('requires the token on unknown routes too, so 404s reveal nothing', async () => {
    expect((await app.inject({ url: '/api/nope' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/%61pi/workflows' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/nope', headers: AUTH })).statusCode).toBe(404);
  });

  it('keeps /health public', async () => {
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const response = await app.inject({
      url: '/api/workflows',
      headers: { ...AUTH, host: 'evil.example:41731' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects requests from a page outside the origin allowlist, even with the token', async () => {
    const response = await app.inject({
      url: '/api/workflows',
      headers: { ...AUTH, origin: 'http://evil.example' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('answers CORS preflight from the desktop origin without a token', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/executions',
      headers: {
        origin: 'http://tauri.localhost',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    expect(String(response.headers['access-control-allow-headers'])).toMatch(/authorization/i);
  });
});

describe('workflows API', () => {
  it('lists registered workflows with their input JSON Schema and states', async () => {
    const response = await app.inject({ url: '/api/workflows', headers: AUTH });
    const { workflows } = listWorkflowsResponseSchema.parse(response.json());

    expect(workflows.map((w) => w.id)).toEqual(['generate-spec', 'demo-sequence']);
    const demo = workflows.find((w) => w.id === 'demo-sequence');
    expect(demo).toMatchObject({
      category: 'Demo',
      availability: { available: true },
      inputSchema: { type: 'object', required: ['items'] },
    });
    expect(demo?.states.map((s) => [s.name, s.kind])).toEqual([
      ['NORMALIZE', 'step'],
      ['PROCESS', 'step'],
      ['SUMMARIZE', 'step'],
      ['REVIEW', 'approval'],
      ['DONE', 'final'],
      ['REJECTED', 'final'],
    ]);
  });

  it('returns 404 for an unknown workflow and 400 for an invalid id', async () => {
    const unknown = await app.inject({ url: '/api/workflows/fix-bug', headers: AUTH });
    const invalid = await app.inject({ url: '/api/workflows/Not_Valid', headers: AUTH });

    expect(unknown.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
    expect(errorCode(invalid.json())).toBe('VALIDATION_FAILED');
  });
});

describe('executions API', () => {
  it('starts an execution and returns before it finishes', async () => {
    const execution = await startDemo({ items: ['x'], stepDelayMs: 200, requireReview: false });

    expect(['PENDING', 'RUNNING']).toContain(execution.status);
    expect(execution.workflowName).toBe('Demo sequence');
    expect(execution.states.map((s) => s.name)).toContain('PROCESS');
    await app.workflowRuntime.engine.whenIdle();
    expect((await getExecution(execution.id)).status).toBe('COMPLETED');
  });

  it('rejects invalid workflow input with field-level issues', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers: AUTH,
      payload: { workflowId: 'demo-sequence', input: { items: [] } },
    });

    expect(response.statusCode).toBe(400);
    const body = apiErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.issues?.[0]?.path).toBe('items');
  });

  it('returns 404 when starting an unknown workflow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/executions',
      headers: AUTH,
      payload: { workflowId: 'fix-bug', input: {} },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns a finished execution with steps, output and history', async () => {
    const started = await startDemo();
    await app.workflowRuntime.engine.whenIdle();

    const execution = await getExecution(started.id);
    expect(execution).toMatchObject({
      status: 'COMPLETED',
      currentState: 'DONE',
      currentStateTitle: 'Done',
      output: { count: 2 },
    });
    expect(execution.steps.map((s) => [s.title, s.status])).toEqual([
      ['Normalize items', 'SUCCEEDED'],
      ['Process items', 'SUCCEEDED'],
      ['Summarize', 'SUCCEEDED'],
    ]);
    expect(execution.steps.every((s) => s.durationMs !== null)).toBe(true);
  });

  it('lists executions newest first, with filters', async () => {
    const first = await startDemo();
    const second = await startDemo();
    await app.workflowRuntime.engine.whenIdle();

    const all = listExecutionsResponseSchema.parse(
      (await app.inject({ url: '/api/executions', headers: AUTH })).json(),
    );
    const completed = listExecutionsResponseSchema.parse(
      (await app.inject({ url: '/api/executions?status=COMPLETED&limit=1', headers: AUTH })).json(),
    );
    const otherWorkflow = listExecutionsResponseSchema.parse(
      (await app.inject({ url: '/api/executions?workflowId=fix-bug', headers: AUTH })).json(),
    );

    expect(all.executions.map((e) => e.id)).toEqual([second.id, first.id]);
    expect(completed).toMatchObject({ total: 2 });
    expect(completed.executions).toHaveLength(1);
    expect(otherWorkflow).toEqual({ executions: [], total: 0 });
  });

  it('rejects an invalid status filter', async () => {
    const response = await app.inject({ url: '/api/executions?status=DONE', headers: AUTH });

    expect(response.statusCode).toBe(400);
  });

  it('returns events incrementally for polling', async () => {
    const started = await startDemo();
    await app.workflowRuntime.engine.whenIdle();

    const url = `/api/executions/${started.id}/events`;
    const all = listEventsResponseSchema.parse(
      (await app.inject({ url, headers: AUTH })).json(),
    ).events;
    const lastId = all.at(-2)?.id ?? 0;
    const rest = listEventsResponseSchema.parse(
      (await app.inject({ url: `${url}?after=${lastId}`, headers: AUTH })).json(),
    ).events;

    expect(all[0]?.type).toBe('EXECUTION_CREATED');
    expect(rest).toEqual(all.slice(-1));
  });

  it('returns 400 for a malformed id and 404 for an unknown one', async () => {
    const malformed = await app.inject({ url: '/api/executions/abc', headers: AUTH });
    const unknown = await app.inject({
      url: '/api/executions/00000000-0000-4000-8000-000000000000',
      headers: AUTH,
    });

    expect(malformed.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(404);
  });

  it('reports counts by status and recently finished executions', async () => {
    await startDemo();
    await app.workflowRuntime.engine.whenIdle();

    const stats = executionStatsResponseSchema.parse(
      (await app.inject({ url: '/api/executions/stats', headers: AUTH })).json(),
    );

    expect(stats.total).toBe(1);
    expect(stats.byStatus.COMPLETED).toBe(1);
    expect(stats.byStatus.RUNNING).toBe(0);
    expect(stats.recentlyFinished).toHaveLength(1);
  });
});

describe('cancel API', () => {
  it('requests cancellation of a running execution, which then ends CANCELLED', async () => {
    const started = await startDemo({ items: ['a', 'b', 'c'], stepDelayMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await app.inject({
      method: 'POST',
      url: `/api/executions/${started.id}/cancel`,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(202);
    const body = cancelExecutionResponseSchema.parse(response.json());
    expect(body.outcome).toBe('requested');
    expect(body.execution.cancelRequested).toBe(true);

    await app.workflowRuntime.engine.whenIdle();
    const execution = await getExecution(started.id);
    expect(execution.status).toBe('CANCELLED');
    expect(execution.cancelRequested).toBe(false);
    expect(execution.steps.at(-1)).toMatchObject({
      status: 'INTERRUPTED',
      error: { code: 'CANCELLED' },
    });
  });

  it('refuses to cancel a finished execution', async () => {
    const started = await startDemo();
    await app.workflowRuntime.engine.whenIdle();

    const response = await app.inject({
      method: 'POST',
      url: `/api/executions/${started.id}/cancel`,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(409);
    expect(errorCode(response.json())).toBe('CONFLICT');
  });
});

describe('approvals API', () => {
  async function waitingExecution() {
    const started = await startDemo({ items: ['a'], stepDelayMs: 0 });
    await app.workflowRuntime.engine.whenIdle();
    const execution = await getExecution(started.id);
    expect(execution.status).toBe('WAITING_FOR_APPROVAL');
    if (execution.pendingApproval === null) throw new Error('expected a pending approval');
    return { execution, approval: execution.pendingApproval };
  }

  const decide = (executionId: string, approvalId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/executions/${executionId}/approvals/${approvalId}/decision`,
      headers: AUTH,
      payload,
    });

  it('exposes the pending request in the execution detail', async () => {
    const { approval } = await waitingExecution();

    expect(approval).toMatchObject({
      approvalType: 'summary-review',
      stateTitle: 'Review summary',
      status: 'PENDING',
      request: { summary: 'Processed 1 item(s): A.' },
      decision: null,
    });
  });

  it('approves with feedback and completes the execution', async () => {
    const { execution, approval } = await waitingExecution();

    const response = await decide(execution.id, approval.id, {
      decision: 'APPROVED',
      feedback: '  fine  ',
    });

    expect(response.statusCode).toBe(200);
    const after = executionResponseSchema.parse(response.json()).execution;
    expect(after).toMatchObject({ status: 'COMPLETED', pendingApproval: null });
    expect(after.approvals[0]).toMatchObject({
      status: 'APPROVED',
      decision: { decision: 'APPROVED', feedback: 'fine' },
    });
  });

  it('rejects and cancels the execution', async () => {
    const { execution, approval } = await waitingExecution();

    const response = await decide(execution.id, approval.id, { decision: 'REJECTED' });

    expect(executionResponseSchema.parse(response.json()).execution.status).toBe('CANCELLED');
  });

  it('refuses a second decision, an unknown approval and an invalid decision', async () => {
    const { execution, approval } = await waitingExecution();
    await decide(execution.id, approval.id, { decision: 'APPROVED' });

    const again = await decide(execution.id, approval.id, { decision: 'REJECTED' });
    const unknown = await decide(execution.id, '00000000-0000-4000-8000-000000000000', {
      decision: 'APPROVED',
    });
    const invalid = await decide(execution.id, approval.id, { decision: 'MAYBE' });

    expect(again.statusCode).toBe(409);
    expect(unknown.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
  });
});

describe('resume API', () => {
  it('refuses to resume an execution that is not INTERRUPTED', async () => {
    const started = await startDemo();
    await app.workflowRuntime.engine.whenIdle();

    const response = await app.inject({
      method: 'POST',
      url: `/api/executions/${started.id}/resume`,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(409);
  });
});
