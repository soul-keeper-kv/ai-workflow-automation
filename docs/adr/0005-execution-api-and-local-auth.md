# ADR 0005 — Execution API, local API authentication and cancellation

- Status: accepted
- Date: 2026-10-26
- Phase: 2
- Closes: ADR 0003, open question 1 (authentication)

## Context

Phase 2 adds the first endpoints that change state (start, cancel). The blueprint (§15.1)
requires that the backend not trust every local request, and that CORS not be treated as
authentication.

## Decision

### Who may call the API

All of these run in one `onRequest` hook (`apps/backend/src/plugins/security.ts`), before CORS
and before any route:

1. **Host check.** The `Host` header must be `127.0.0.1`, `localhost` or `[::1]` (any port).
   This stops DNS rebinding, where a malicious site points its own domain at 127.0.0.1.
2. **Origin check.** When a request carries an `Origin` header, it must be in the allowlist,
   otherwise 403. Requests without `Origin` (curl, other processes) still need the token.
3. **Token.** `Authorization: Bearer <AAP_API_TOKEN>` is required on every route except the
   explicit public list (`/health`). The token must be at least 32 characters, and the
   backend refuses to start without one. It is compared through SHA-256 digests with
   `timingSafeEqual`.
   - The check uses the **matched route**, not the raw URL, so encoded paths such as
     `/%61pi/...` cannot slip past.
   - Unknown routes need the token too, so a 404 tells a stranger nothing.
   - CORS preflight (`OPTIONS`) is exempt, because browsers never send credentials on it.

**Where the token comes from**

- **Development:** `pnpm dev` runs `scripts/dev.mjs`, which generates a random token per run
  and passes it to the backend (`AAP_API_TOKEN`) and the UI (`NEXT_PUBLIC_AAP_API_TOKEN`).
- **Packaged desktop app (not built yet):** Tauri will generate the token per launch, pass it
  to the backend process, and give it to the webview through a Tauri command. It must never
  be part of the static bundle.

### API

| Method and path                                  | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `GET /health`                                    | Liveness; public                                    |
| `GET /api/workflows`                             | Catalog from the registry, with input JSON Schema   |
| `GET /api/workflows/:workflowId`                 | One workflow                                        |
| `POST /api/executions`                           | Start; returns 201 once persisted, before any step  |
| `GET /api/executions`                            | History; `workflowId`, `status`, `limit`, `offset`  |
| `GET /api/executions/stats`                      | Counts by status and recently finished executions   |
| `GET /api/executions/:executionId`               | Detail with step attempts and the workflow's states |
| `POST /api/executions/:executionId/cancel`       | Cooperative cancel (below)                          |
| `GET /api/executions/:executionId/events?after=` | Events after an id, for polling                     |

- Every request and response is validated with the Zod schemas in `@aap/shared`. The UI parses
  every response with the same schemas.
- Domain errors map to HTTP in one place (`plugins/error-handler.ts`):
  - validation → 400 `VALIDATION_FAILED`, with field `issues`;
  - unknown workflow or execution → 404;
  - a state conflict or stale revision → 409 `CONFLICT`;
  - an oversized payload → 413.

**Cancellation.** The engine aborts the running step's `AbortSignal` and returns
`202 { outcome: "requested" }`. The run loop records the result when the step settles:

- the step is INTERRUPTED with code `CANCELLED`, and the execution becomes CANCELLED;
- if the step finished anyway, its result is kept and then the execution stops;
- an execution with nothing running (queued, PENDING, INTERRUPTED) is cancelled at once:
  `200 { outcome: "cancelled" }`.

While a step runs, only its run loop writes to that execution, so a cancel cannot race a step
commit.

**Live updates.** The UI polls every second while an execution is PENDING or RUNNING, and lists
every 3 s. SSE can replace this later without changing the API.

### UI

- Screens: dashboard, workflow catalog, start form, execution history (filters in the URL),
  execution monitor.
- The start form is built from the workflow's input JSON Schema
  (`features/workflows/schema-fields.ts`), with no per-workflow code. It validates on the
  client with `z.fromJSONSchema` of the same schema, then shows the server's field issues
  when there are any. The server is authoritative.
- Ids are query parameters (`/executions/detail?id=`), because of the static export
  (ADR 0002).
- Zustand is not used. There is no client state that is not either server state (TanStack
  Query) or URL state.

## Consequences

- `pnpm start` and any other standalone run of the backend need `AAP_API_TOKEN`.
- In development the token is inlined into the UI bundle served on `localhost:3000`. Another
  browser page cannot use it: its Origin is rejected and CORS blocks reading responses. A
  local process could read it, but such a process already runs as the user. This is
  acceptable for development only. Production must use the Tauri path.
- Migration 0001 removes the `CHECK` on `workflow_events.event_type`. The event list grows
  (here: `CANCEL_REQUESTED`), and SQLite can only change a `CHECK` by rebuilding the table.
  Event types are validated in code when read. A test applies 0000, writes data, then 0001,
  and checks that nothing was lost.
- The cancel request flag lives in memory. If the app dies before the step settles, recovery
  marks the execution INTERRUPTED, and the user can cancel it again.

## Rejected alternatives

- **No authentication, relying on the loopback binding.** Any local process or web page could
  then start workflows that edit code.
- **Cookie sessions.** There is no login; the webview's origin (`tauri://` / `http://tauri.localhost`)
  is cross-site to the API, so cookies would also need SameSite exceptions and CSRF
  protection. A bearer token is simpler and is not sent automatically.
- **Mutual TLS or a Unix socket or named pipe.** Strong, but the webview cannot use them
  without a Rust proxy that cannot be built or tested on this machine yet.
- **SSE or WebSocket now.** Polling is enough for a local app and one user; it was kept until
  the execution flow worked end to end.
- **Keyset pagination.** Offset paging over a local history is fast enough and simpler.
- **Hand-written forms per workflow.** The blueprint forbids workflow-specific UI code in the
  catalog. The schema already describes the input.
