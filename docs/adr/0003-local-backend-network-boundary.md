# ADR 0003 — Local backend network boundary

- Status: accepted (production launch is still open, see below)
- Date: 2026-10-25
- Phase: 0

## Context

The backend runs on the user's machine, but any local process or web page can try to reach a
localhost port (blueprint §15.1). Phase 0 exposes only `GET /health`. State-changing endpoints
arrive in Phase 2.

## Decision

- **Loopback only, enforced.** `AAP_HOST` accepts only `127.0.0.1` or `::1`. Anything else
  fails at startup with a configuration error. It is a rule, not a default.
- **Port.** `AAP_PORT`, default `41731` (`DEFAULT_BACKEND_PORT` in `@aap/shared`). `0` asks the
  OS for a free port.
- **CORS allowlist.** `AAP_ALLOWED_ORIGINS`, default `http://localhost:3000` (dev),
  `http://tauri.localhost` (Tauri on Windows) and `tauri://localhost` (Tauri on macOS and
  Linux). CORS only stops other web pages from reading responses. It is not authentication.
- **Error envelope.** Every non-2xx response is `{ "error": { "code", "message" } }` with a
  stable code (`API_ERROR_CODES` in `@aap/shared`). 5xx responses never include internal
  messages or stack traces.
- **Logging.** Pino through Fastify, JSON by default, pretty in `pnpm dev`. Authorization and
  cookie headers are redacted.
- **The Next.js dev server** binds to `localhost` too, not to every interface.

## Open questions

1. ~~Authentication.~~ Closed by [ADR 0005](0005-execution-api-and-local-auth.md).
2. **How Tauri starts and stops the backend in production.** Options: a sidecar binary built
   with Node single-executable applications (which must carry `better-sqlite3`'s native
   module), or spawning a Node.js installed on the machine. This decides how the frontend learns
   the port and the token. Still open: it cannot be built or tested without a Rust toolchain.
3. **The app identifier** (`com.aiautomationplatform.desktop`) decides the OS app-data
   directory, where SQLite lives. Development data goes to its `dev` subfolder (ADR 0004);
   confirm the identifier before the first release, because changing it later moves user data.

## Observed during Phase 0

Stopping the shell that ran `pnpm dev` on Windows left both Node servers running. They had to
be killed with `taskkill /T`. Cancellation in Phase 3 (blueprint §9.5) must terminate whole
process trees, for example with Windows job objects or `taskkill /T`, not only the direct
child.

## Rejected alternatives

- **Binding to `0.0.0.0` with a firewall rule.** It depends on machine configuration outside
  the app's control.
- **Relying on CORS as access control.** CORS does not stop non-browser clients, and a
  request without an `Origin` header is not blocked.
