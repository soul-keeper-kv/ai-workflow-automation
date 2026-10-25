import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// One config for the whole monorepo. eslint-config-next is not used: its bundled react,
// import and jsx-a11y plugins do not support ESLint 10. See docs/adr/0001.
export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/.next/',
    '**/out/',
    '**/coverage/',
    '**/next-env.d.ts',
    'apps/desktop/src-tauri/target/',
    'apps/desktop/src-tauri/gen/',
  ]),

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // `const { omitted, ...rest } = value` is the idiomatic way to drop a key.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },

  {
    // Plain JS config files are not part of any tsconfig.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    files: ['apps/desktop/**/*.{ts,tsx}'],
    extends: [nextPlugin.configs['core-web-vitals'], reactHooks.configs.flat.recommended],
    settings: {
      next: { rootDir: 'apps/desktop/' },
    },
  },
);
