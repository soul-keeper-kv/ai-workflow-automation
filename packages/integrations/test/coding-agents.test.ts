import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ClaudeCodeAgent,
  CodingAgentError,
  FakeCodingAgent,
  parseCmdShim,
  type CodingAgentRequest,
} from '../src/index.js';

const fakeCli = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'aap-agent-'));
});
afterEach(() => rmSync(workdir, { recursive: true, force: true }));

function agent(mode: string) {
  return new ClaudeCodeAgent({
    executable: process.execPath,
    prefixArgs: [fakeCli],
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, AAP_API_TOKEN: 'secret', CLAUDECODE: '1' },
  });
}

function request(overrides: Partial<CodingAgentRequest> = {}): CodingAgentRequest {
  return {
    workingDirectory: workdir,
    prompt: 'Describe this code.',
    mode: 'read-only',
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const echoSchema = z.object({
  args: z.array(z.string()),
  cwd: z.string(),
  stdin: z.string(),
  sawToken: z.boolean(),
  sawNested: z.boolean(),
});

async function errorCode(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof CodingAgentError)) throw new Error('expected a CodingAgentError');
  return { code: error.code, retryable: error.retryable };
}

describe('ClaudeCodeAgent', () => {
  it('runs read-only and restricted, with the prompt on stdin, in the working directory', async () => {
    const result = await agent('success').execute(request());
    const echo = echoSchema.parse(JSON.parse(result.text));

    expect(echo.stdin).toBe('Describe this code.');
    expect(echo.cwd.toLowerCase()).toBe(workdir.toLowerCase());
    expect(echo.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--restricted',
        '--strict-mcp-config',
        '--no-session-persistence',
      ]),
    );
    expect(echo.args.join(' ')).toContain('--tools Read,Grep,Glob');
    expect(echo.args.join(' ')).toContain('--permission-prompts none');
    expect(echo.args.join(' ')).toContain('--output-format json');
    expect(result).toMatchObject({ costUsd: 0.01, turns: 2, sessionId: 's1' });
  });

  it('never passes the platform token or nested-session markers to the CLI', async () => {
    const echo = echoSchema.parse(JSON.parse((await agent('success').execute(request())).text));

    expect(echo.sawToken).toBe(false);
    expect(echo.sawNested).toBe(false);
  });

  it('reports rate limits as retryable', async () => {
    expect(await errorCode(agent('rate-limited').execute(request()))).toEqual({
      code: 'AGENT_RATE_LIMITED',
      retryable: true,
    });
  });

  it('rejects output it does not understand', async () => {
    expect((await errorCode(agent('garbage').execute(request()))).code).toBe(
      'AGENT_OUTPUT_INVALID',
    );
  });

  it('stops a run that exceeds its timeout', async () => {
    expect(await errorCode(agent('slow').execute(request({ timeoutMs: 300 })))).toEqual({
      code: 'AGENT_TIMEOUT',
      retryable: false,
    });
  });

  it('stops a run when cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    expect(
      (await errorCode(agent('slow').execute(request({ signal: controller.signal })))).code,
    ).toBe('AGENT_CANCELLED');
  });

  it('probes the version, and reports a missing CLI as unavailable', async () => {
    expect(await agent('success').probe()).toMatchObject({
      available: true,
      version: '9.9.9 (Claude Code)',
    });

    const missing = await new ClaudeCodeAgent({ executable: join(workdir, 'nope') }).probe();
    expect(missing).toMatchObject({ available: false });
    expect(missing.reason).toMatch(/not found|Could not start/);
  });
});

describe('parseCmdShim', () => {
  it('follows an npm shim to its .exe', () => {
    const dir = join(workdir, 'npm');
    mkdirSync(join(dir, 'node_modules', 'tool', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'tool', 'bin', 'tool.exe'), '');
    writeFileSync(
      join(dir, 'tool.cmd'),
      '@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n',
    );

    expect(parseCmdShim(join(dir, 'tool.cmd'), 'node')).toEqual({
      executable: join(dir, 'node_modules', 'tool', 'bin', 'tool.exe'),
      prefixArgs: [],
    });
  });

  it('runs a .js shim target with node', () => {
    const dir = join(workdir, 'npm');
    mkdirSync(join(dir, 'node_modules', 'tool'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'tool', 'cli.js'), '');
    writeFileSync(join(dir, 'tool.cmd'), '"%_prog%"  "%dp0%\\node_modules\\tool\\cli.js" %*');

    expect(parseCmdShim(join(dir, 'tool.cmd'), 'node')).toEqual({
      executable: 'node',
      prefixArgs: [join(dir, 'node_modules', 'tool', 'cli.js')],
    });
  });
});

describe('FakeCodingAgent', () => {
  it('answers deterministically and records the request', async () => {
    const fake = new FakeCodingAgent({ respond: (req, call) => `${call}:${req.prompt}` });

    expect((await fake.execute(request())).text).toBe('1:Describe this code.');
    expect(fake.requests).toHaveLength(1);
    expect((await fake.probe()).available).toBe(true);
  });
});
