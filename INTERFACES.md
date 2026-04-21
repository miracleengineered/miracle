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
- main — final target, merged into only at Phase 5 cutover

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
- Hook-to-job correlation (Phase 4 / C4)
- Integration and end-to-end testing (Phase 4 / C8)
- TIER_3_ENABLED flip and `main` merge (Phase 5 cutover)

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
| job_id        | TEXT    | NULL in Phase 3; populated by C4 correlation in Phase 4 |
| session_id    | TEXT    | NOT NULL; CC's native session_id, always present in payload |
| event_type    | TEXT    | NOT NULL |
| payload_json  | TEXT    | NOT NULL; verbatim CC payload (not normalized) |
| received_at   | INTEGER | NOT NULL (unix ms, assigned by C5 on POST receipt) |

Indices: `idx_hook_events_session` on `(session_id, received_at)`,
`idx_hook_events_job` on `(job_id, received_at)`.

The `job_id` column and its index exist now so C4's Phase 4 correlation
work is an UPDATE-and-populate operation, not a schema migration.

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

---

# Phase 4 contracts — C4 / C8

Phase 4 turns Tier 3 from parallel component shipping into an integrated,
end-to-end-tested system. C4 fills the correlation gap Phase 3 deferred
(hook events get their `job_id` populated); C8 wires everything together
and validates with a real worker subprocess driving the full chain. C4
must land before C8 — C8 depends on the correlator existing.

### Terminology — session_id

"session_id" appears in three places and refers to the same underlying
id with different ownership:

- **Telegram `ClaudeSession.sessionId`** (`src/session.ts:89`, persisted
  to `/tmp/claude-telegram-session.json`). Used by the bot for
  `claude --resume` and signature dedup; predates Tier 3 and is not
  owned by Tier 3.
- **Hook payload `session_id`** (`src/http-listener/listener.ts:71`,
  stored as `hook_events.session_id`). The value CC emits in hook
  POST bodies when its subprocess runs.
- **Orchestrator session tracking** (C4's responsibility, does not
  exist today). The in-memory map from `jobId` → `sessionId` that the
  orchestrator maintains after capturing `session_id` from a spawned
  worker's stream output.

These are the same `session_id` value when the orchestrator spawns a
worker — CC emits identical ids in its stream events and its HTTP hook
payloads. C4 adds the third site (orchestrator tracking) and uses it to
correlate the other two.

## C4 — Hook-to-job correlation

### Scope

- Orchestrator captures `session_id` from spawned worker subprocess
  stream output (analogue of the existing Telegram-side pattern at
  `src/session.ts:438–441`).
- A `Correlator` module maintains the `sessionId` ↔ `jobId` mapping
  for live jobs.
- Correlation backfill: populate `hook_events.job_id` for rows whose
  `session_id` maps to a known job. Both eager (at write time, if a
  mapping exists) and lazy (post-hoc UPDATE for rows written before
  the mapping was registered) paths are in scope.
- Race handling: hook arrives before orchestrator registers the
  session (lazy backfill covers this); hook arrives for a cancelled
  or failed job (correlator retains mapping until retired); orchestrator
  restart mid-session (recovery behavior is a C4 design call — document
  the choice).

### Out of scope for C4

- Any C8 integration work: listener wiring into a run configuration,
  hook registration in `~/miracle-workspace/.claude/settings.json`,
  `SqliteNotebookClient.appendHookEvent` real implementation, e2e
  test harness.
- Tightening `InMemoryNotebookClient.appendHookEvent` parameter type
  (flagged as cleanup in `phase-3-merge-report.md:35`; lands in C8).
- Production `TIER_3_ENABLED` flag changes (Phase 5 cutover).

### Schema impact

None. `hook_events.job_id` stays `TEXT NULL` with no FK to `jobs.id`;
`idx_hook_events_job` already exists from Phase 3. Correlation is a
soft link populated by UPDATE, not a schema migration. Rows whose
`session_id` never maps to a known job (stray hooks, rows from before
the orchestrator started tracking, etc.) are acceptable with `job_id`
remaining NULL — consistent with the Phase 3 schema design choice to
keep correlation best-effort.

### Interface (sketch — C4 sub-branch refines)

New module: `src/correlation/correlator.ts`. Suggested shape:

```ts
export interface Correlator {
  // Called by orchestrator when a worker subprocess for `jobId` emits
  // its first `session_id` event. Stores the mapping and triggers a
  // backfill of any hook_events rows already written for this session.
  registerSession(jobId: string, sessionId: string): Promise<void>;

  // Called by the write path (C8's appendHookEvent) or a standalone
  // backfill pass. Returns the known jobId for sessionId, or null.
  resolveJobId(sessionId: string): string | null;

  // Called by orchestrator when `jobId` reaches a terminal state.
  // Retires the mapping; any final backfill pass for still-NULL
  // hook_events rows happens here.
  retireJob(jobId: string): Promise<void>;
}
```

The interface sketch above names the three moments correlation must
handle: session starts, hook arrives, job ends. C4 MUST validate this
against its implementation and MAY change the method shapes, argument
types, or async boundaries. The sketch is a design anchor, not a
contract.

## C8 — Integration and end-to-end testing

### Scope

- Implement `SqliteNotebookClient.appendHookEvent` as a real INSERT
  into `hook_events` (the skeleton currently throws; see
  `src/notebook/client.ts:143` for the `InMemoryNotebookClient`
  reference impl). `job_id` handling integrates with the correlator
  from C4.
- Tighten `InMemoryNotebookClient.appendHookEvent` parameter type
  to match the interface (flagged in `phase-3-merge-report.md:35`).
- Wire `ExpressHttpListener` (from C5) into a run configuration that
  starts alongside the orchestrator process. Listener is not
  standalone per INTERFACES.md § C5.
- Register the CC HTTP hook in
  `~/miracle-workspace/.claude/settings.json`. The JSON shape is
  spec'd in § C5 → "CC integration"; back up the file to
  `settings.json.pre-tier-3-backup` before editing.
- End-to-end test: spawn an actual `claude` worker subprocess against
  a test DB at `~/.miracle/tier-3-test.db`, run a trivial job, assert
  the full chain: worker emits hook POSTs → listener writes
  `hook_events` → orchestrator tracks session → correlator populates
  `job_id` → final `hook_events` row shows non-NULL `job_id` bound to
  the expected job.

### Out of scope for C8

- `TIER_3_ENABLED` flag flip (Phase 5 cutover).
- Merge `tier-3` → `main` (Phase 5 cutover).
- Any write to the production DB at `~/.miracle/queue.db` (C8 uses
  `~/.miracle/tier-3-test.db`).
- Modifying any launchd job.
- Modifying `~/miracle-workspace/CLAUDE.md` or
  `~/miracle-workspace/.claude/agents/`.
- Any file under `~/miracle-workspace/` other than the `"hooks"`
  array in `settings.json` (backed up first).

### Hook registration

See INTERFACES.md § C5 → "CC integration" for the authoritative JSON
fragment. C8 installs exactly that shape — no other fields added, no
command-hook wrapping. The `"async"` question in the C5 spec is
resolved by C8 based on e2e test observations.

### End-to-end test shape

Proposed file: `tests/e2e/full-chain.test.ts`. Suggested structure
(C8 sub-branch refines):

1. Spin up a fresh `~/.miracle/tier-3-test.db` (migration runs on
   first boot per C3).
2. Start `ExpressHttpListener` + orchestrator using `SqliteNotebookClient`.
3. Dispatch a one-step job that shells out to `claude -p "<trivial
   prompt>"` with the hook registration pointed at `127.0.0.1:8787`.
4. Wait for the job to complete.
5. Assert: at least one `hook_events` row exists for the job, and
   after `retireJob` its `job_id` is populated and matches the job's
   `id`.

Gate the test behind `E2E=1` using `process.env.E2E === "1"` so
`npm test` without the gate does not regress from 134 passing.

## Phase 4 code layout

- `src/correlation/correlator.ts` — `Correlator` interface + default
  impl (C4).
- `src/correlation/correlator.test.ts` — unit tests for correlator
  (C4).
- `src/orchestrator/` — extended to capture `session_id` from worker
  stream output and call `Correlator.registerSession` / `retireJob`
  (C4).
- `src/notebook/client.ts` — `SqliteNotebookClient.appendHookEvent`
  real impl (C8); `InMemoryNotebookClient.appendHookEvent` type
  tightening (C8).
- `tests/e2e/full-chain.test.ts` — end-to-end test (C8).
- `~/miracle-workspace/.claude/settings.json.pre-tier-3-backup` — backup
  of the settings file before C8 adds the hook registration (C8).

## Phase 4 branch map

- `tier-3-c4` — Correlator + orchestrator session_id capture + backfill
  logic. Forks from the pre-kickoff commit that introduces this
  section.
- `tier-3-c8` — Real `SqliteNotebookClient.appendHookEvent` + listener
  wiring + hook registration + e2e test. Forks from `tier-3` after
  `tier-3-c4` merges.
- Phase 4 seals at tag `phase-4-complete` after `tier-3-c8` merges
  green. Phase 5 cutover (flag flip + `main` merge) begins only after
  Phase 4 seals.

---

# Phase 5 — Cutover

Phase 5 turns Tier 3 on in production. It is a deliberately narrow
phase: no implementation work, no new components, no spec changes.
Any readiness work (smoke tests, operator docs, rollback plan) lands
in Phase 4 before its seal.

Phase 5 scope:

- Flip `TIER_3_ENABLED` from `"false"` to `"true"` in the live config
  read by `src/config/env.ts`.
- Merge `tier-3` branch into `main`.
- Tag `phase-5-complete` on `main` at the merge commit.

Phase 5 is out of scope until Phase 4 seals at `phase-4-complete`.
