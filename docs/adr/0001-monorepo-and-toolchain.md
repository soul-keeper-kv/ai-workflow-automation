# ADR 0001 — Monorepo layout and toolchain versions

- Status: accepted
- Date: 2026-10-25
- Phase: 0

## Context

The blueprint fixes the stack (pnpm workspaces, TypeScript strict, ESLint, Prettier, Vitest)
but asks for compatible, supported versions rather than "latest everything". Several majors
shipped recently and do not all work together.

Machine at the time of writing: Windows 11, Node 26.5.0 (Current line, not LTS yet), pnpm
11.24.0, no Rust toolchain, no Visual Studio C++ Build Tools.

## Decision

**Layout.** Three workspace packages:

| Package        | Path              | Purpose                                       |
| -------------- | ----------------- | --------------------------------------------- |
| `@aap/backend` | `apps/backend`    | Fastify API, later the workflow worker        |
| `@aap/desktop` | `apps/desktop`    | Next.js UI and the Tauri shell (`src-tauri/`) |
| `@aap/shared`  | `packages/shared` | Zod schemas and types shared by both apps     |

`packages/workflow-core` is created in Phase 1, when it has code. No empty placeholder packages.

**Versions.**

| Tool       | Choice             | Why                                                                               |
| ---------- | ------------------ | --------------------------------------------------------------------------------- |
| Node       | `engines: >=24.11` | 24 is the Active LTS line. Node 26 also works (used for all checks).              |
| pnpm       | 11.24.0            | Installed version, pinned through `packageManager`.                               |
| TypeScript | 6.0                | typescript-eslint 8 supports `typescript <6.1`. TypeScript 7 would break linting. |
| ESLint     | 10                 | ESLint 9 is end of life (npm marks 9.39.5 "no longer supported").                 |
| Vitest     | 5                  | Current major; supports Node 24 and 26.                                           |

**Shared versions live once**, in the `catalog:` section of `pnpm-workspace.yaml`.

**Supply-chain settings** in `pnpm-workspace.yaml`:

- `minimumReleaseAge: 10080`: pnpm only resolves versions published at least 7 days ago.
  To take an urgent security fix earlier, add the package to `minimumReleaseAgeExclude`.
- `allowBuilds`: dependency install scripts are blocked unless listed (pnpm 11 default).
  Only `esbuild` is listed, set to `false`; its script only re-checks a binary pnpm already
  installed.

**`@aap/shared` is compiled** to `dist/` with `tsc`. Consumers import the compiled output.
Root scripts (`dev`, `lint`, `typecheck`, `test`) build it first.

**One ESLint flat config** at the root (`eslint.config.mjs`) with type-aware
typescript-eslint rules everywhere, plus `@next/eslint-plugin-next` and
`eslint-plugin-react-hooks` for `apps/desktop`.

**Scripts run through pnpm's shell emulator** (`shellEmulator: true`), so `FOO=bar cmd`
works on Windows without `cross-env`.

## Consequences

- No jsx-a11y or eslint-plugin-react rules for now (see rejected alternatives). The React
  Hooks and Next rules still run.
- Editing `packages/shared` while `pnpm dev` runs needs `pnpm build:shared` to show up in the
  apps. This is acceptable while the package is small.
- `better-sqlite3` 13.0.3 ships a prebuilt binary for Node 26 on win-x64 (checked in a scratch
  install), so Phase 1 does not need a C++ toolchain for SQLite.

## Rejected alternatives

- **TypeScript 7.** typescript-eslint 8 declares `typescript <6.1`.
- **ESLint 9 with `eslint-config-next`.** ESLint 9 is end of life.
- **ESLint 10 with `eslint-config-next`.** It bundles eslint-plugin-react 7.37.5,
  eslint-plugin-import 2.32 and eslint-plugin-jsx-a11y 6.10.2, whose peer ranges stop at
  ESLint 9. They might work, but nobody has declared that they do. Revisit when they support
  ESLint 10.
- **Consuming `@aap/shared` as TypeScript source.** No build step in dev, but the compiled
  backend (`node dist/server.js`) could not import it without a bundler. Revisit if the backend
  gets bundled for the Tauri sidecar.
- **Turborepo or Nx.** Three packages do not need a task graph or remote cache.
- **One ESLint config per package.** Same rules three times; one root config keeps them in one
  place.
