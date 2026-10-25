import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingAgentError,
  FakeCodingAgent,
  WorkspaceFilesystem,
  type FakeResponder,
} from '@aap/integrations';
import {
  ExecutionEngine,
  SqliteExecutionStore,
  WorkflowRegistry,
  openWorkflowDatabase,
  type WorkflowDatabase,
} from '@aap/workflow-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGenerateSpecWorkflow } from '../src/index.js';
import { validSpec } from './spec-format.test.js';

let base: string;
let workspace: string;
let database: WorkflowDatabase;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aap-spec-'));
  workspace = join(base, 'workspace');
  mkdirSync(join(workspace, 'app', 'src'), { recursive: true });
  mkdirSync(join(base, 'outside'), { recursive: true });
  writeFileSync(
    join(workspace, 'app', 'src', 'page.tsx'),
    "export default function Page() { fetch('/api/customers'); return <SearchForm required />; }",
  );
  writeFileSync(
    join(workspace, 'app', 'src', 'api.ts'),
    "export const search = () => fetch('/api/x');",
  );
  writeFileSync(join(base, 'outside', 'secret.ts'), 'export const secret = 1;');
  database = openWorkflowDatabase(':memory:');
});

afterEach(() => {
  database.close();
  rmSync(base, { recursive: true, force: true });
});

async function setup(respond: FakeResponder = () => validSpec(), delayMs = 0) {
  const filesystem = await WorkspaceFilesystem.create([workspace]);
  const agent = new FakeCodingAgent({ respond, delayMs });
  const workflow = createGenerateSpecWorkflow({
    filesystem,
    codingAgent: agent,
    limits: { agentRetryDelayMs: 10 },
  });
  const store = new SqliteExecutionStore(database.db);
  const engine = new ExecutionEngine({ registry: new WorkflowRegistry([workflow]), store });
  return { agent, store, engine };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  sourceDirectory: join(workspace, 'app'),
  outputDirectory: join(workspace, 'specs'),
  specTitle: 'Customer search',
  ...overrides,
});

describe('generate-spec', () => {
  it('drafts a spec, waits for review, and saves it once approved', async () => {
    const { agent, store, engine } = await setup();
    const { id } = engine.start('generate-spec', input({ instructions: 'Focus on search.' }));
    await engine.whenIdle();

    expect(store.getExecution(id)?.status).toBe('WAITING_FOR_APPROVAL');
    const approval = store.getPendingApproval(id);
    expect(approval?.request).toMatchObject({
      title: 'Customer search',
      markdown: validSpec().trim(),
      filesAnalysed: 2,
      generatedBy: 'Fake agent (offline, no AI)',
    });

    const request = agent.requests[0];
    expect(request?.mode).toBe('read-only');
    expect(request?.workingDirectory.toLowerCase()).toBe(join(workspace, 'app').toLowerCase());
    expect(request?.prompt).toContain('- `src/page.tsx`');
    expect(request?.prompt).toContain("api calls: fetch '/api/customers'");
    expect(request?.prompt).toContain('Focus on search.');

    engine.decide(id, approval?.id ?? '', 'APPROVED', 'ok');
    await engine.whenIdle();

    const execution = store.getExecution(id);
    expect(execution?.status).toBe('COMPLETED');
    const files = readdirSync(join(workspace, 'specs'));
    expect(files).toEqual([`customer-search-${id.slice(0, 8)}.md`]);
    const saved = readFileSync(join(workspace, 'specs', files[0] ?? ''), 'utf8');
    expect(saved).toMatch(/^---\ntitle: "Customer search"/);
    expect(saved).toContain('review_feedback: "ok"');
    expect(saved).toContain('# Customer search specification');
    expect(execution?.output).toMatchObject({ fileCount: 2, reviewFeedback: 'ok' });
  });

  it('regenerates once with the problems found, then asks for review', async () => {
    const { agent, store, engine } = await setup((_req, call) =>
      call === 1 ? '# Too short' : validSpec(),
    );
    const { id } = engine.start('generate-spec', input());
    await engine.whenIdle();

    expect(store.getExecution(id)?.status).toBe('WAITING_FOR_APPROVAL');
    expect(agent.calls).toBe(2);
    expect(agent.requests[1]?.prompt).toContain(
      'Your previous draft was rejected by automatic checks',
    );
  });

  it('fails with SPEC_INVALID when every draft fails the checks', async () => {
    const { agent, store, engine } = await setup(() => '# Still too short');
    const { id } = engine.start('generate-spec', input());
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      currentState: 'INVALID_SPEC',
      error: { code: 'SPEC_INVALID' },
    });
    expect(agent.calls).toBe(2);
  });

  it('refuses a source folder outside the workspace, without calling the agent', async () => {
    const { agent, store, engine } = await setup();
    const { id } = engine.start('generate-spec', input({ sourceDirectory: join(base, 'outside') }));
    await engine.whenIdle();

    expect(store.getExecution(id)).toMatchObject({
      status: 'FAILED',
      error: { code: 'PATH_NOT_ALLOWED' },
    });
    expect(agent.calls).toBe(0);
  });

  it('refuses an output folder outside the workspace', async () => {
    const { store, engine } = await setup();
    const { id } = engine.start(
      'generate-spec',
      input({ outputDirectory: join(base, 'outside', 'specs') }),
    );
    await engine.whenIdle();

    expect(store.getExecution(id)?.error?.code).toBe('PATH_NOT_ALLOWED');
    expect(existsSync(join(base, 'outside', 'specs'))).toBe(false);
  });

  it('fails clearly when no file matches', async () => {
    const { store, engine } = await setup();
    const { id } = engine.start('generate-spec', input({ extensions: ['.cobol'] }));
    await engine.whenIdle();

    expect(store.getExecution(id)?.error?.code).toBe('NO_SOURCE_FILES');
  });

  it('retries a rate-limited agent call', async () => {
    const { agent, store, engine } = await setup((_req, call) => {
      if (call === 1) throw new CodingAgentError('AGENT_RATE_LIMITED', 'slow down', true);
      return validSpec();
    });
    const { id } = engine.start('generate-spec', input());
    await engine.whenIdle();

    expect(store.getExecution(id)?.status).toBe('WAITING_FOR_APPROVAL');
    expect(agent.calls).toBe(2);
    expect(store.listStepRuns(id).find((s) => s.status === 'FAILED')?.error?.code).toBe(
      'AGENT_RATE_LIMITED',
    );
  });

  it('does not retry an agent failure that is not retryable', async () => {
    const { agent, store, engine } = await setup(() => {
      throw new CodingAgentError('AGENT_FAILED', 'broken', false);
    });
    const { id } = engine.start('generate-spec', input());
    await engine.whenIdle();

    expect(store.getExecution(id)?.error?.code).toBe('AGENT_FAILED');
    expect(agent.calls).toBe(1);
  });

  it('saves nothing when the reviewer rejects the draft', async () => {
    const { store, engine } = await setup();
    const { id } = engine.start('generate-spec', input());
    await engine.whenIdle();

    engine.decide(id, store.getPendingApproval(id)?.id ?? '', 'REJECTED', 'wrong screen');

    expect(store.getExecution(id)?.status).toBe('CANCELLED');
    expect(readdirSync(join(workspace, 'specs'))).toEqual([]);
  });

  it('stops the agent when the execution is cancelled', async () => {
    const { agent, store, engine } = await setup(() => validSpec(), 10_000);
    const { id } = engine.start('generate-spec', input());
    for (let i = 0; i < 200 && agent.calls === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    engine.cancel(id);
    await engine.whenIdle();

    expect(store.getExecution(id)?.status).toBe('CANCELLED');
    expect(agent.requests[0]?.signal.aborted).toBe(true);
  });
});
