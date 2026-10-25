import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp, type App } from '../src/app.js';
import { AUTH, TEST_TOKEN, testConfig } from './helpers.js';

const lineSchema = z.looseObject({ level: z.number(), msg: z.string() });

let app: App | undefined;
let config: ReturnType<typeof testConfig> | undefined;
afterEach(async () => {
  await app?.close();
  config?.cleanup();
});

async function appWithLogs() {
  const lines: string[] = [];
  config = testConfig({ AAP_LOG_LEVEL: 'debug' });
  app = await buildApp(config, { logDestination: { write: (line) => lines.push(line) } });
  await app.ready();
  const parsed = () => lines.map((line) => lineSchema.parse(JSON.parse(line)));
  return { app, lines, parsed };
}

describe('structured logging', () => {
  it('never writes the API token, even when a request carries it', async () => {
    const { app, lines } = await appWithLogs();

    await app.inject({ url: '/api/workflows', headers: AUTH });
    await app.inject({ url: `/api/nope?token=${TEST_TOKEN}`, headers: AUTH });
    await app.inject({
      url: '/api/workflows',
      headers: { authorization: `Bearer ${TEST_TOKEN}x` },
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TEST_TOKEN);
  });

  it('logs routes, not raw URLs, and successful GETs only at debug level', async () => {
    const { app, parsed } = await appWithLogs();

    await app.inject({ url: '/api/executions?status=COMPLETED', headers: AUTH });

    const request = parsed().find((line) => line.msg === 'Request completed');
    expect(request).toMatchObject({ level: 20, route: '/api/executions', statusCode: 200 });
    expect(JSON.stringify(request)).not.toContain('status=COMPLETED');
  });

  it('logs execution and step fields the blueprint asks for (§15.4)', async () => {
    const { app, parsed } = await appWithLogs();

    app.workflowRuntime.engine.start('demo-sequence', {
      items: ['a'],
      stepDelayMs: 0,
      requireReview: false,
    });
    await app.workflowRuntime.engine.whenIdle();

    const step = parsed().find((line) => line.msg === 'Step succeeded');
    expect(step).toMatchObject({
      executionId: expect.any(String) as unknown,
      workflowId: 'demo-sequence',
      stepId: 'NORMALIZE',
      eventType: 'STEP_SUCCEEDED',
      result: 'succeeded',
      durationMs: expect.any(Number) as unknown,
    });
  });
});
