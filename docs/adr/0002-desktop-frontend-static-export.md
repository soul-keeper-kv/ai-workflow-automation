# ADR 0002 — Desktop frontend: Next.js static export inside Tauri

- Status: accepted
- Date: 2026-10-25
- Phase: 0

## Context

Tauri serves the frontend as files from disk; there is no Node.js server inside the desktop
app. All authoritative logic belongs to the Fastify backend anyway (blueprint §5.1).

## Decision

- `next.config.ts` sets `output: 'export'` and `images.unoptimized: true`. `next build` writes
  `apps/desktop/out/`, which Tauri bundles (`frontendDist: ../out`).
- In development, `tauri dev` loads `http://localhost:3000`. Its `beforeDevCommand` runs the
  root `pnpm dev`, which starts both the backend and `next dev`.
- All data is fetched in the browser with TanStack Query from the Fastify API. Every response
  is parsed with the Zod schemas from `@aap/shared` before use.
- The API base URL is inlined at build time from `NEXT_PUBLIC_AAP_API_URL`. The default port
  comes from `DEFAULT_BACKEND_PORT` in `@aap/shared`.
- shadcn/ui is set up with the CLI defaults (Base UI primitives, `base-nova` style).
- Fonts use the system UI stack. `next/font/google` was removed after `shadcn init` added it,
  because it downloads fonts at build time, which fails offline and on restricted networks.

## Consequences

- These Next.js features are unavailable: SSR, route handlers, server actions, proxy
  (middleware), rewrites, redirects, headers, ISR, and dynamic routes without
  `generateStaticParams`.
- Pages for one execution cannot be `/executions/[id]`, because IDs are only known at runtime.
  Use a query parameter (`/executions/detail?id=…`) and read it on the client.
- Once the backend gets an ephemeral port, the URL must come from Tauri at runtime instead of
  a build-time variable.
- **Known gap:** `app.security.csp` in `tauri.conf.json` is `null`, the Tauri template
  default. A CSP that limits `connect-src` to the backend must be added and tested once Tauri
  can be built on a development machine. It was not added blind, because a wrong CSP leaves a
  blank window and could not be verified here.

## Rejected alternatives

- **Running the Next.js server inside the desktop app.** It needs a second bundled Node server
  next to the backend, for features the app does not need.
- **Vite + React SPA.** It fits Tauri equally well, but the blueprint names Next.js, and
  static export removes the practical difference.
