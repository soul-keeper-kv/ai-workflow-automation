import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessSpawnError, runProcess } from '../src/index.js';

const node = process.execPath;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aap-proc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (script: string, extra: Partial<Parameters<typeof runProcess>[0]> = {}) =>
  runProcess({ executable: node, args: ['-e', script], cwd: dir, timeoutMs: 10_000, ...extra });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runProcess', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await run('console.log("out"); console.error("err"); process.exitCode = 3');

    expect(result).toMatchObject({ exitCode: 3, timedOut: false, aborted: false });
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });

  it('writes stdin and closes it', async () => {
    const result = await run(
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.toUpperCase()))',
      { stdin: 'hello' },
    );

    expect(result.stdout.trim()).toBe('HELLO');
  });

  it('passes arguments as-is, never through a shell', async () => {
    const tricky = 'a & echo injected | "quoted" $(whoami) %PATH%';
    const result = await runProcess({
      executable: node,
      args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', tricky],
      cwd: dir,
      timeoutMs: 10_000,
    });

    expect(JSON.parse(result.stdout)).toEqual([tricky]);
  });

  it('caps output and keeps reading so the child is not blocked', async () => {
    const result = await run('process.stdout.write("x".repeat(3 * 1024 * 1024))', {
      maxOutputBytes: 1000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(1000);
    expect(result.stdoutTruncated).toBe(true);
  });

  it('kills a process that runs past its timeout', async () => {
    const result = await run('setTimeout(() => {}, 60_000)', { timeoutMs: 200 });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(8_000);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await run('setTimeout(() => {}, 60_000)', { signal: controller.signal });

    expect(result.aborted).toBe(true);
  });

  it('kills grandchildren too, not only the direct child', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const grandchild = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000)`;
    const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(() => {}, 60_000)`;
    const controller = new AbortController();
    const running = run(parent, { signal: controller.signal });
    for (let i = 0; i < 100 && !existsSync(pidFile); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    expect(isAlive(grandchildPid)).toBe(true);

    controller.abort();
    await running;
    for (let i = 0; i < 40 && isAlive(grandchildPid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(isAlive(grandchildPid)).toBe(false);
  });

  it('reports a missing executable as ProcessSpawnError', async () => {
    await expect(
      runProcess({
        executable: join(dir, 'does-not-exist'),
        args: [],
        cwd: dir,
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ProcessSpawnError);
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    writeFileSync(join(dir, 'marker'), '');

    const result = await run('require("fs").rmSync("marker")', { signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(existsSync(join(dir, 'marker'))).toBe(true);
  });
});
