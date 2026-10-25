import { delimiter, isAbsolute, resolve } from 'node:path';
import { DEFAULT_BACKEND_PORT } from '@aap/shared';
import { z } from 'zod';
import { defaultDataDir } from './paths.js';

/** The API must never listen on a non-loopback interface. */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000', // Next.js dev server; also what `tauri dev` loads
  'http://tauri.localhost', // Tauri production webview on Windows
  'tauri://localhost', // Tauri production webview on macOS and Linux
] as const;

/** scheme://host[:port] with no path. `new URL().origin` cannot be used: it returns "null" for tauri://. */
const originSchema = z
  .string()
  .regex(/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/i, 'must be scheme://host[:port] without a path');

const envSchema = z.object({
  AAP_HOST: z.enum(LOOPBACK_HOSTS).default('127.0.0.1'),
  AAP_PORT: z.coerce.number().int().min(0).max(65_535).default(DEFAULT_BACKEND_PORT),
  AAP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? [...DEFAULT_ALLOWED_ORIGINS]
        : value
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(originSchema)),
  AAP_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  AAP_LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  AAP_DATA_DIR: z.string().trim().min(1).optional(),
  /** Shared secret for /api/*. `pnpm dev` generates one per run; the desktop app will too. */
  AAP_API_TOKEN: z
    .string({ error: 'is required (at least 32 characters); `pnpm dev` sets it for you' })
    .min(32, 'must be at least 32 characters'),
  /** Folders workflows may read and write, separated like PATH (`;` on Windows, `:` elsewhere). */
  AAP_WORKSPACE_ROOTS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(delimiter)
        .map((root) => root.trim())
        .filter((root) => root !== ''),
    )
    .pipe(z.array(z.string().refine(isAbsolute, 'workspace roots must be absolute paths'))),
  AAP_CODING_AGENT: z.enum(['claude-code', 'fake']).default('claude-code'),
  AAP_CLAUDE_EXECUTABLE: z.string().trim().min(1).optional(),
  AAP_CLAUDE_MODEL: z.string().trim().min(1).optional(),
  AAP_CLAUDE_MAX_BUDGET_USD: z.coerce.number().positive().max(100).optional(),
  /** How long the offline fake agent pretends to work. Demos and end-to-end tests. */
  AAP_FAKE_AGENT_DELAY_MS: z.coerce.number().int().min(0).max(600_000).default(1_500),
});

export interface AppConfig {
  host: (typeof LOOPBACK_HOSTS)[number];
  /** 0 asks the OS for a free port. */
  port: number;
  /** Origins allowed by CORS. CORS is not authentication; it only limits which pages can read responses. */
  allowedOrigins: readonly string[];
  logLevel: z.infer<typeof envSchema>['AAP_LOG_LEVEL'];
  logFormat: z.infer<typeof envSchema>['AAP_LOG_FORMAT'];
  /** Absolute directory for the SQLite database. Never inside the source repository. */
  dataDir: string;
  /** Bearer token every /api/* request must present. Never logged. */
  apiToken: string;
  /** The only folders workflows may touch. Empty: workflows that need files are unavailable. */
  workspaceRoots: readonly string[];
  codingAgent: {
    kind: 'claude-code' | 'fake';
    executable: string | undefined;
    model: string | undefined;
    maxBudgetUsd: number | undefined;
    fakeDelayMs: number;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid backend configuration:\n${z.prettifyError(result.error)}`);
  }
  const parsed = result.data;
  return {
    host: parsed.AAP_HOST,
    port: parsed.AAP_PORT,
    allowedOrigins: parsed.AAP_ALLOWED_ORIGINS,
    logLevel: parsed.AAP_LOG_LEVEL,
    logFormat: parsed.AAP_LOG_FORMAT,
    dataDir: resolve(parsed.AAP_DATA_DIR ?? defaultDataDir()),
    apiToken: parsed.AAP_API_TOKEN,
    workspaceRoots: parsed.AAP_WORKSPACE_ROOTS,
    codingAgent: {
      kind: parsed.AAP_CODING_AGENT,
      executable: parsed.AAP_CLAUDE_EXECUTABLE,
      model: parsed.AAP_CLAUDE_MODEL,
      maxBudgetUsd: parsed.AAP_CLAUDE_MAX_BUDGET_USD,
      fakeDelayMs: parsed.AAP_FAKE_AGENT_DELAY_MS,
    },
  };
}
