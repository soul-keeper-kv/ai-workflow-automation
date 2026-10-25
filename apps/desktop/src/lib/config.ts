import { DEFAULT_BACKEND_PORT } from '@aap/shared';
import { z } from 'zod';

/**
 * Base URL of the local backend. Inlined at build time from NEXT_PUBLIC_AAP_API_URL.
 * Once Tauri launches the backend on an ephemeral port, this will come from Tauri at runtime.
 */
export const apiBaseUrl = z
  .url({ protocol: /^https?$/ })
  .parse(process.env.NEXT_PUBLIC_AAP_API_URL ?? `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`);
