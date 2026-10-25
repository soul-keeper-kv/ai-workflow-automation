import { DEFAULT_BACKEND_PORT } from '@aap/shared';
import { z } from 'zod';

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
});

export interface AppConfig {
  host: (typeof LOOPBACK_HOSTS)[number];
  /** 0 asks the OS for a free port. */
  port: number;
  /** Origins allowed by CORS. CORS is not authentication; it only limits which pages can read responses. */
  allowedOrigins: readonly string[];
  logLevel: z.infer<typeof envSchema>['AAP_LOG_LEVEL'];
  logFormat: z.infer<typeof envSchema>['AAP_LOG_FORMAT'];
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
  };
}
