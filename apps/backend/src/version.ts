import { readFileSync } from 'node:fs';
import { z } from 'zod';

const packageJsonSchema = z.object({ version: z.string().min(1) });

/**
 * Version from this package's package.json, so the number lives in one place.
 * `../package.json` resolves from both src/ (tsx) and dist/ (compiled), since each is one level
 * below the package root. Revisit if the backend is ever bundled into a single file.
 */
export const APP_VERSION = packageJsonSchema.parse(
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
).version;
