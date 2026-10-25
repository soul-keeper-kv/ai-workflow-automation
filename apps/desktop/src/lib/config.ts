import { DEFAULT_BACKEND_PORT } from '@aap/shared';
import { z } from 'zod';

/**
 * How the UI reaches the local backend. Both values are inlined at build time:
 * `pnpm dev` generates the token per run and passes it to both processes.
 * In the packaged desktop app they will come from Tauri at runtime instead (docs/adr/0005);
 * that path is not built yet.
 */
export const apiBaseUrl = z
  .url({ protocol: /^https?$/ })
  .parse(process.env.NEXT_PUBLIC_AAP_API_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);

export const apiToken: string | null = process.env.NEXT_PUBLIC_AAP_API_TOKEN ?? null;
