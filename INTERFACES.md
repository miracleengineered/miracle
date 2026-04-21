# Phase 2 Interface Spec — Tier 3

Authoritative conventions shared across C1, C2, C7. Do not diverge.

## Job ID format
UUID v7 (time-ordered). Generated via the `uuid` npm package v9+, function
`uuidv7()`. One canonical helper lives at `src/util/jobId.ts` and all
surfaces import from there — no inline generation.

## Worktree path format
Worker worktrees live at:
  ~/Projects/miracle/tier-3-build/worktrees/{job_id}/
This directory is git-ignored on the tier-3 branch via .gitignore. Worker
worktrees are real git worktrees (not symlinks), created by C2's lifecycle
API.

## Environment variables
- TIER_3_ENABLED — "true" | "false", default "false". Read via src/config/env.ts.
- MIRACLE_DB_PATH — default "~/.miracle/queue.db"
- MIRACLE_WORKTREE_ROOT — default "~/Projects/miracle/tier-3-build/worktrees"
All env reads go through src/config/env.ts. No direct process.env access
outside that module.

## Code layout on tier-3 branch
- src/orchestrator/ — C1's output (orchestrator process)
- src/notebook/ — notebook client interface + in-memory stub (this phase);
  real SQLite impl lands in Phase 3 (C3)
- src/config/env.ts — shared env loader
- src/util/jobId.ts — shared UUID v7 helper
- scripts/worktree/ — C2's output (worktree lifecycle scripts)
- launchd/com.miracle.bot.plist — C7's output (edit existing file; see C7 prompt)

## Branch naming
- tier-3-c1, tier-3-c2, tier-3-c7 — per-surface sub-branches
- tier-3 — integration branch, merged into by CC after validation
- main — final target, merged into only after Phase 5

## Test runner
vitest 4.0.18 (config at vitest.config.ts). Include pattern covers both
`tests/**/*.test.ts` and `src/**/*.test.ts` so co-located unit tests are
picked up alongside legacy `tests/` files. Install tool is bun (matches the
live bot per AGENTS.md); the npm `test` script (`vitest run`) works
unchanged whether invoked via npm or bun.

All new Tier 3 code under src/ adopts this runner. Each surface runs
`tsc --noEmit` and `npm test` in its own worktree before declaring done.
CC re-runs both in the tier-3-build integration worktree after merge.

## Validation gate
Each Codex surface:
1. Runs `tsc --noEmit` — must exit 0
2. Runs `npm test` — must exit 0
3. Writes a session-log.md entry with tsc + test output summary
4. Commits and pushes its sub-branch (local only; no remote)
CC then:
1. Checks out tier-3 in the integration worktree
2. Runs `git merge --no-ff tier-3-cN`
3. Re-runs `tsc --noEmit` and `npm test`
4. If green, writes a review entry to session-log.md tagged [reviewed: tier-3-cN]
5. If red, reverts the merge, writes a failure entry, adds an item to
   approval-queue.md flagging the user to re-invoke the surface

## Out of scope for Phase 2
- Real SQLite notebook implementation (Phase 3 / C3)
- HTTP webhook hooks (Phase 3 / C5)
- Model routing (Phase 3 / C6)
- Conflict resolution (Phase 3 / C4)
- Bot entry point integration with TIER_3_ENABLED flag (Phase 5 / C8)

---

# Phase 3 contracts — C3 / C5 / C6

Authoritative contract text for the three Phase 3 surfaces. Sub-branches
(`tier-3-c3`, `tier-3-c5`, `tier-3-c6`) fork from the pre-kickoff commit
that introduces this section.

Shared TypeScript types live in `src/types/phase3.ts` — all three
surfaces import from there rather than redeclaring.

## C3 — SQLite notebook

### Database location
`~/.miracle/queue.db`, read via `loadEnv().miracleDbPath` (default
`"~/.miracle/queue.db"`, expanded via `expandHome`). No new env var.
The parent directory `~/.miracle/` does not exist until C3 creates it
on first boot.

### Schema

Two tables. Initial DDL scaffolded at
`src/notebook/migrations/001_phase3_init.sql` (not executed by the
pre-kickoff commit; C3 wires migration-on-first-boot).

**jobs** (identity + state, narrow):

| column          | type    | notes |
| --------------- | ------- | ----- |
| id              | TEXT    | PRIMARY KEY |
| parent_id       | TEXT    | NULL for root jobs |
| kind            | TEXT    | NOT NULL |
| status          | TEXT    | NOT NULL; one of `pending` \| `running` \| `completed` \| `failed` \| `cancelled` |
| payload         | TEXT    | NOT NULL; JSON-encoded `Job.payload` |
| model           | TEXT    | NULL; set by C6 routing at dispatch time |
| worker_id       | TEXT    | NULL; set when a worker claims the job |
| created_at      | INTEGER | NOT NULL (unix ms) |
| updated_at      | INTEGER | NOT NULL (unix ms) |
| completed_at    | INTEGER | NULL; unix ms, set when status reaches a terminal state (`completed` \| `failed` \| `cancelled`) |
| result_summary  | TEXT    | NULL; JSON string (terminal result only) |
| plan_snapshot   | TEXT    | NULL; JSON-encoded `Job.planSnapshot` when present |

Indices: `idx_jobs_status` on `(status)`, `idx_jobs_parent` on `(parent_id)`.

`payload` and `plan_snapshot` are serialized JSON blobs — not query
targets, no indices. TypeScript consumers deserialize at read time to
populate `Job.payload` / `Job.planSnapshot`. `result_summary` remains
the terminal-result column (set alongside `completed_at` when a job
enters a terminal state) and is not overloaded as a generic blob store.

**hook_events** (append-only trail):

| column        | type    | notes |
| ------------- | ------- | ----- |
| event_id      | INTEGER | PRIMARY KEY AUTOINCREMENT |
| job_id        | TEXT    | NULL in Phase 3 (correlation is Phase 4+ work) |
| session_id    | TEXT    | NOT NULL; CC's native session_id, always present in payload |
| event_type    | TEXT    | NOT NULL |
| payload_json  | TEXT    | NOT NULL; verbatim CC payload (not normalized) |
| received_at   | INTEGER | NOT NULL (unix ms, assigned by C5 on POST receipt) |

Indices: `idx_hook_events_session` on `(session_id, received_at)`,
`idx_hook_events_job` on `(job_id, received_at)`.

The `job_id` column and its index exist now so Phase 4+ correlation is
an UPDATE-and-populate operation, not a schema migration.

### NotebookClient factory (`src/notebook/client.ts`)

Two implementations, one factory:

- `InMemoryNotebookClient` — permanent test double (not removed when
  C3 ships). Retained for unit tests and as the orchestrator's default
  until C3 flips the default to sqlite.
- `SqliteNotebookClient` — Phase 3 / C3 production impl. Pre-kickoff
  ships a skeleton (all methods throw `"SqliteNotebookClient not
  implemented (Phase 3 / C3)"`).

Factory:

```ts
createNotebookClient(config?: NotebookConfig): NotebookClient
// config defaults to { backend: "memory" }
// { backend: "sqlite", dbPath } returns SqliteNotebookClient
```

Production default (once C3 lands): `{ backend: "sqlite", dbPath: loadEnv().miracleDbPath }`.
Test default: `{ backend: "memory" }`.

### Hook-to-job correlation — DEFERRED

Phase 3 stores hook events with `session_id` populated and `job_id`
always NULL. Rationale:

- Orchestrator has no session_id tracking today
- Designing correlation without real hook payload data would be guessing
- Narrow Phase 3 preserves C1/C3/C5/C6 parallel independence
- `job_id` column + index exist so Phase 4+ correlation is a backfill,
  not a migration

Correlation work lands in **Phase 4+ (likely bundled with C4)**. C5's
sub-branch does NOT scope correlation.

## C5 — HTTP webhook listener

### Contract

- Local Express HTTP server, bound to `127.0.0.1:8787` (loopback-only, no auth)
- Single endpoint: `POST /hook`
- Request body: CC hook payload JSON — see
  https://code.claude.com/docs/en/hooks for the payload shape
- Response: `200` with empty body on success
- Response: `500` with JSON error body on notebook write failure
  (non-blocking per CC HTTP hook spec — CC continues regardless of 5xx)
- Phase 3 is **log-only**. No blocking/gating decisions returned. No
  job correlation. Write-and-ack only.
- Lifecycle: starts as part of the orchestrator process; does NOT run
  standalone.

### CC integration

Uses CC's native HTTP hook transport. Registration shape (installed by
C8, not C5) — this goes in `~/miracle-workspace/.claude/settings.json`:

```jsonc
{
  "hooks": [
    {
      "type": "http",
      "url": "http://127.0.0.1:8787/hook"
      // "async": true is an open question — C5 sub-branch evaluates;
      // default to sync if uncertain.
    }
  ]
}
```

No command-hook wrapping. The pre-kickoff commit does NOT modify
`~/miracle-workspace/.claude/settings.json`; that is C8 install work.

### Scaffold

`src/http-listener/types.ts` exports `HttpListenerConfig`,
`HttpListener`, `HookEventPayload`. Express server implementation lands
in the C5 sub-branch.

## C6 — Model routing

### Contract

Static routing table keyed by job `kind`, with orchestrator override:

```ts
type ModelName = "opus" | "sonnet" | "haiku";
type ModelRoute = { default: ModelName };
type RoutingTable = Record<string, ModelRoute>;

function resolveModel(kind: string, override?: ModelName): ModelName;
```

Resolution:

1. If `override` present → return `override`
2. Else lookup `kind` in the table → return `route.default`
3. If `kind` is not in the table → `throw new Error("unknown kind: ...")`
   (fail loud; unknown kinds indicate an orchestrator bug)

### Config location

`src/routing/routing-table.json` — version-controlled, editable without
code changes. Loaded once at module import via `readFileSync`.

### Seed values

Pre-kickoff ships an **empty** table: `{}`. The C6 sub-branch audits
real orchestrator call sites (two production kinds today:
`"orchestrator"` and `"orchestrator-subtask"`) and decides routing on
evidence. Pre-kickoff does not guess routing values.

With an empty table, `resolveModel` throws `"unknown kind: ..."` for
every non-override call — this is the correct Phase 3 behavior. The
orchestrator does not invoke `resolveModel` until the C6 sub-branch
wires it and populates the table.

## Phase 3 code layout

- `src/types/phase3.ts` — shared types (JobStatus, JobRow, HookEventRow,
  NotebookConfig, NotebookBackend, HookEventPayload, HttpListenerConfig,
  ModelName, ModelRoute, RoutingTable)
- `src/notebook/client.ts` — InMemoryNotebookClient + SqliteNotebookClient
  skeleton + `createNotebookClient` factory
- `src/notebook/migrations/001_phase3_init.sql` — initial DDL scaffold
- `src/http-listener/types.ts` — listener contract types
- `src/routing/resolveModel.ts` — `resolveModel` (real impl)
- `src/routing/routing-table.json` — routing table (empty `{}` at pre-kickoff)

## Phase 3 branch map

- `tier-3-c3` — SQLite notebook (implements SqliteNotebookClient,
  writes migration runner)
- `tier-3-c5` — HTTP listener (Express server bound to 127.0.0.1:8787)
- `tier-3-c6` — Model routing (populates routing-table.json, wires
  `resolveModel` into the orchestrator)
- All three fork from the pre-kickoff commit that introduces this section.
