import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import {
  API_URL,
  BACKEND_ENTRY,
  BACKEND_PORT,
  DESKTOP_OUT,
  E2E_TOKEN,
  SAMPLE_APP,
  UI_PORT,
  UI_URL,
} from './constants.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

/** Serves the static export the way Tauri does: files from out/, `/a/b` → `a/b.html`. */
function serveStatic(root: string): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', UI_URL).pathname);
      const relative = normalize(pathname).replace(/^[\\/]+/, '');
      if (relative.split(sep).includes('..')) {
        response.writeHead(400).end();
        return;
      }
      const candidates =
        relative === ''
          ? ['index.html']
          : [relative, `${relative}.html`, join(relative, 'index.html')];
      for (const candidate of candidates) {
        try {
          const body = await readFile(join(root, candidate));
          response.writeHead(200, {
            'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream',
          });
          response.end(body);
          return;
        } catch {
          // Try the next candidate.
        }
      }
      response.writeHead(404).end('not found');
    })();
  });
  return new Promise((resolve) => server.listen(UI_PORT, '127.0.0.1', () => resolve(server)));
}

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${API_URL}/health`)).ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - started > timeoutMs) throw new Error('backend did not become healthy');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * One isolated environment per test: a fresh database, a workspace with a copy of the sample
 * app, the compiled backend with the offline fake agent, and the UI on a static server.
 */
export class Stack {
  readonly base = mkdtempSync(join(tmpdir(), 'aap-e2e-'));
  readonly dataDir = join(this.base, 'data');
  readonly workspace = join(this.base, 'workspace');
  readonly sampleApp = join(this.workspace, 'sample-app');
  readonly specsDir = join(this.workspace, 'specs');
  #backend: ChildProcess | undefined;
  #ui: Server | undefined;
  #fakeAgentDelayMs: number;

  constructor(options: { fakeAgentDelayMs?: number } = {}) {
    this.#fakeAgentDelayMs = options.fakeAgentDelayMs ?? 300;
    mkdirSync(this.workspace, { recursive: true });
    cpSync(SAMPLE_APP, this.sampleApp, { recursive: true });
  }

  async start(): Promise<void> {
    this.#ui = await serveStatic(DESKTOP_OUT);
    await this.startBackend();
  }

  async startBackend(): Promise<void> {
    this.#backend = spawn(process.execPath, [BACKEND_ENTRY], {
      env: {
        ...process.env,
        AAP_API_TOKEN: E2E_TOKEN,
        AAP_PORT: String(BACKEND_PORT),
        AAP_DATA_DIR: this.dataDir,
        AAP_WORKSPACE_ROOTS: this.workspace,
        AAP_CODING_AGENT: 'fake',
        AAP_FAKE_AGENT_DELAY_MS: String(this.#fakeAgentDelayMs),
        AAP_ALLOWED_ORIGINS: UI_URL,
        AAP_LOG_LEVEL: 'warn',
      },
      // E2E_BACKEND_LOGS=1 shows the backend's logs; expected failures make them noisy.
      stdio: ['ignore', process.env.E2E_BACKEND_LOGS === '1' ? 'inherit' : 'ignore', 'inherit'],
    });
    await waitForHealth();
  }

  /** Kills the backend without any chance to clean up: a crash, as far as it can tell. */
  async crashBackend(): Promise<void> {
    const backend = this.#backend;
    if (backend === undefined || backend.exitCode !== null) return;
    const exited = new Promise((resolve) => backend.once('exit', resolve));
    backend.kill('SIGKILL');
    await exited;
    this.#backend = undefined;
  }

  async stop(): Promise<void> {
    await this.crashBackend();
    await new Promise<void>((resolve) => {
      if (this.#ui === undefined) resolve();
      else this.#ui.close(() => resolve());
    });
    rmSync(this.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
