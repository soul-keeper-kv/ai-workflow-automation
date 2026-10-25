import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorResponseSchema,
  executionResponseSchema,
  integrationsResponseSchema,
  listWorkflowsResponseSchema,
} from '@aap/shared';
import { FakeCodingAgent } from '@aap/integrations';
import { REQUIRED_SECTIONS } from '@aap/workflow-generate-spec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { AUTH, testConfig } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function spec(): string {
  return [
    '# Sample spec',
    '',
    ...REQUIRED_SECTIONS.flatMap((s) => [
      `## ${s}`,
      `Described from \`src/page.tsx\`. `.repeat(3),
      '',
    ]),
  ].join('\n');
}

async function appWith(env: Record<string, string>, agent?: FakeCodingAgent): Promise<App> {
  const config = testConfig(env);
  const app = await buildApp(config, agent === undefined ? {} : { codingAgent: agent });
  await app.ready();
  cleanups.push(() => config.cleanup());
  return app;
}

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aap-ws-')));
  mkdirSync(join(root, 'app', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'app', 'src', 'page.tsx'),
    'export default function Page() { return <Form />; }',
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe('generate-spec through the API', () => {
  it('is listed but unavailable without workspace roots, and refuses to start', async () => {
    const app = await appWith({});
    try {
      const { workflows } = listWorkflowsResponseSchema.parse(
        (await app.inject({ url: '/api/workflows', headers: AUTH })).json(),
      );
      const generateSpec = workflows.find((w) => w.id === 'generate-spec');
      expect(generateSpec?.availability.available).toBe(false);
      expect(generateSpec?.availability.reason).toMatch(/AAP_WORKSPACE_ROOTS/);

      const start = await app.inject({
        method: 'POST',
        url: '/api/executions',
        headers: AUTH,
        payload: {
          workflowId: 'generate-spec',
          input: { sourceDirectory: 'x', outputDirectory: 'y' },
        },
      });
      expect(start.statusCode).toBe(409);
      expect(apiErrorResponseSchema.parse(start.json()).error.message).toMatch(/cannot start/);
    } finally {
      await app.close();
    }
  });

  it('shows the configured agent, its data notice and the allowed folders', async () => {
    const root = workspace();
    const app = await appWith({ AAP_WORKSPACE_ROOTS: root });
    try {
      const body = integrationsResponseSchema.parse(
        (await app.inject({ url: '/api/integrations', headers: AUTH })).json(),
      );
      expect(body).toMatchObject({
        codingAgent: { id: 'fake', available: true },
        workspaceRoots: [root],
      });
      expect(body.codingAgent.dataNotice).not.toBe('');
    } finally {
      await app.close();
    }
  });

  it('drafts, waits for review, and saves the approved spec inside the workspace', async () => {
    const root = workspace();
    const app = await appWith(
      { AAP_WORKSPACE_ROOTS: root },
      new FakeCodingAgent({ respond: spec }),
    );
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/executions',
        headers: AUTH,
        payload: {
          workflowId: 'generate-spec',
          input: { sourceDirectory: join(root, 'app'), outputDirectory: join(root, 'specs') },
        },
      });
      expect(started.statusCode).toBe(201);
      const { id } = executionResponseSchema.parse(started.json()).execution;
      await app.workflowRuntime.engine.whenIdle();

      const waiting = executionResponseSchema.parse(
        (await app.inject({ url: `/api/executions/${id}`, headers: AUTH })).json(),
      ).execution;
      expect(waiting.status).toBe('WAITING_FOR_APPROVAL');
      expect(waiting.pendingApproval?.request).toMatchObject({ markdown: spec().trim() });

      const decided = await app.inject({
        method: 'POST',
        url: `/api/executions/${id}/approvals/${waiting.pendingApproval?.id ?? ''}/decision`,
        headers: AUTH,
        payload: { decision: 'APPROVED' },
      });
      expect(decided.statusCode).toBe(200);
      await app.workflowRuntime.engine.whenIdle();

      const done = executionResponseSchema.parse(
        (await app.inject({ url: `/api/executions/${id}`, headers: AUTH })).json(),
      ).execution;
      expect(done.status).toBe('COMPLETED');
      const specPath = (done.output as { specPath: string }).specPath;
      expect(specPath.startsWith(join(root, 'specs'))).toBe(true);
      expect(existsSync(specPath)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
