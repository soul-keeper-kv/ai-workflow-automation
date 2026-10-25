import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface RunProcessOptions {
  /** An executable path or a name found on PATH. Never a shell command line. */
  executable: string;
  /** Passed as separate arguments; nothing is parsed by a shell. */
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Cap per stream; the rest is read and dropped. Default 1 MiB. */
  maxOutputBytes?: number;
  /** POSIX only: time between SIGTERM and SIGKILL. Default 2 s. */
  killGraceMs?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  /** Stopped because `signal` aborted. */
  aborted: boolean;
  durationMs: number;
  pid: number | null;
}

/** The process could not be started at all (missing executable, bad cwd, ...). */
export class ProcessSpawnError extends Error {
  override readonly name = 'ProcessSpawnError';

  constructor(
    readonly executable: string,
    readonly code: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`Could not start "${executable}"${code === undefined ? '' : ` (${code})`}.`, options);
  }
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
/** After the tree is killed, how long to wait for the pipes to close before giving up on them. */
const CLOSE_AFTER_KILL_MS = 5_000;

class CappedBuffer {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    if (this.#size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.#size;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.#chunks.push(kept);
    this.#size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

/**
 * Kills the process and everything it started. Killing only the direct child is not enough:
 * on Windows the grandchildren keep running (seen in practice, docs/adr/0003).
 */
export function killProcessTree(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // /T: the whole tree. /F: force. An explicit executable and arguments, no shell.
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  // The child was spawned detached, so it leads its own process group: signal the group.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, graceMs).unref();
}

/**
 * Runs one external process with a timeout, cancellation and bounded output. Resolves with
 * the result in every case except a failure to start (ProcessSpawnError).
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const started = performance.now();

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: true,
        durationMs: 0,
        pid: null,
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(options.executable, [...options.args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        // POSIX: own process group, so the whole tree can be signalled.
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      reject(new ProcessSpawnError(options.executable, undefined, { cause }));
      return;
    }

    const stdout = new CappedBuffer(maxOutput);
    const stderr = new CappedBuffer(maxOutput);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let closeTimer: NodeJS.Timeout | undefined;

    const stop = () => {
      killProcessTree(child, killGraceMs);
      // If something still holds the pipes open, stop waiting for them eventually.
      closeTimer ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, null);
      }, CLOSE_AFTER_KILL_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        durationMs: Math.round(performance.now() - started),
        pid: child.pid ?? null,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new ProcessSpawnError(options.executable, error.code, { cause: error }));
    });
    child.on('close', (code, signal) => finish(code, signal));

    // A child that exits without reading stdin makes the write fail with EPIPE; ignore it.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');
  });
}
