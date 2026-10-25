import { defineConfig } from 'vitest/config';

// Lets `vitest` run from the repository root (VS Code launch configs, editor extensions).
// Each package still runs its own suite with `pnpm test`; this file only lists them.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/backend'],
  },
});
