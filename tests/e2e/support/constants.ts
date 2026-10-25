import { fileURLToPath } from 'node:url';

/** Fixed, because the UI is built with them inlined (static export). */
export const E2E_TOKEN = 'e2e-token-not-secret-0123456789abcdefghij';
export const BACKEND_PORT = 41799;
export const UI_PORT = 3199;
export const UI_URL = `http://localhost:${UI_PORT}`;
export const API_URL = `http://127.0.0.1:${BACKEND_PORT}`;

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DESKTOP_OUT = fileURLToPath(new URL('../../../apps/desktop/out/', import.meta.url));
export const BACKEND_ENTRY = fileURLToPath(
  new URL('../../../apps/backend/dist/server.js', import.meta.url),
);
export const SAMPLE_APP = fileURLToPath(new URL('../../../examples/sample-app/', import.meta.url));
