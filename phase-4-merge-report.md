# Phase 4 merge report

Phase 4 delivers C4 (hook-to-job correlation) and C8 (integration +
end-to-end testing). C4 must land before C8; C8 depends on the
correlator existing.

## C4 — Hook-to-job correlation

**Status:** complete

**Sub-branch:** tier-3-c4
**Fork point:** 521e0df (phase 4 pre-kickoff: Phase 4 contracts + Phase 5 cutover section)
**Merge target SHA:** 46103b2

### Scope delivered

- New Correlator module at src/correlation/correlator.ts. In-memory
  sessionId ↔ jobId map with registerSession / resolveJobId /
  recordHook / retireJob methods. Restart behavior: mappings are
  process-local; an orchestrator restart can leave rows NULL unless
  a later registerSession re-registers.
- Orchestrator session capture at src/orchestrator/sessionCapture.ts.
  Watches worker stdout for the first session_id emission and calls
  registerSession. Testable parser split out as
  captureWorkerSessionIdFromLines.
- runOrchestrator accepts optional { startWorker, correlator } seam.
  Existing call sites without the seam keep prior behavior.
- Eager correlation in ExpressHttpListener: after appendHookEvent
  writes, the listener calls correlator.recordHook(sessionId) which
  triggers backfill if a mapping exists.

### Deviations from the Phase 4 contracts sketch

- Added recordHook(sessionId) to Correlator (not in original sketch).
  Gives the hook-arrival moment its own API; keeps listener from
  duplicating backfill logic.
- Added optional NotebookClient.backfillHookEvents?(sessionId, jobId)
  (not in original sketch). Needed a notebook-facing backfill seam
  without tightening appendHookEvent or coupling to a concrete impl.
  Pattern matches the existing optional appendHookEvent?.
  **Implication for C8:** C8 now implements TWO sqlite methods,
  not one (appendHookEvent + backfillHookEvents).

### Intentionally unhandled / best-effort

- Worker never emits session_id → rows stay NULL (correct per
  best-effort semantics).
- Orchestrator restart mid-session before re-registration → rows
  stay NULL (documented in correlator.ts).
- SqliteNotebookClient still does not implement appendHookEvent or
  backfillHookEvents; both remain C8 work.

### Test delta

134 → 143 (+9). New tests in correlator.test.ts, listener.test.ts,
orchestrator.test.ts.

### Files changed

9 files changed, +509, -5:
- src/correlation/correlator.ts (new)
- src/correlation/correlator.test.ts (new)
- src/http-listener/listener.ts
- src/http-listener/listener.test.ts
- src/notebook/client.ts
- src/orchestrator/index.ts
- src/orchestrator/orchestrator.test.ts
- src/orchestrator/sessionCapture.ts (new)
- src/orchestrator/types.ts

### Merge verification

- Merge commit SHA: ea9657c6ba8e5fea03dfdd72141a09587b21f1a7
- Merge commit parents: 82b8310 + 46103b2
- bun install result: clean (no dependency changes; 213 installs across 259 packages)
- Typecheck: green
- Tests: 143/143 passing
- Working tree: clean
- Merge conflicts: none

---

## C8 — Integration and end-to-end testing

**Status:** complete, ready to merge.

**Sub-branch:** `tier-3-c8`
**Fork point:** `6318199555b66fed02acb398390a11287b54e28a` (phase 4 merge report: C4 complete)
**Final SHA on branch:** `4846f58eca26306e096d234787beebc6c3e5e71d`

### 1. Files changed

`git diff --stat 6318199..HEAD`:

```
 src/notebook/client.ts       |  47 ++++++++-
 src/notebook/sqlite.test.ts  | 194 +++++++++++++++++++++++++++++++++-
 src/tier3/runtime.test.ts    | 167 +++++++++++++++++++++++++++++
 src/tier3/runtime.ts         |  79 ++++++++++++++
 tests/e2e/full-chain.test.ts | 245 +++++++++++++++++++++++++++++++++++++++++++
 5 files changed, 728 insertions(+), 4 deletions(-)
```

Commits (straight-line, no amends):
- `c46fb84` c8: add hook event persistence to SqliteNotebookClient
- `e160650` c8: tier-3 runtime factory composing listener + correlator + orchestrator
- `4846f58` c8: end-to-end chain test behind E2E=1 gate

### 2. Test counts

- Baseline at fork point: **143/143** passing.
- After C8 (default `npm test`): **157 passed + 1 skipped (158 total)**. Delta +14: +8 sqlite hook-event unit tests, +6 Tier3Runtime unit tests. The skipped test is the gated e2e.
- With `E2E=1 npm test`: **158/158 passing**. Delta +1: the live-chain e2e.

### 3. Design calls (answers to the four kickoff questions)

**Q1 — Run configuration placement.** `src/tier3/runtime.ts` exposes
`createTier3Runtime(config)`. Module-dir convention matches
`src/correlation/`, `src/orchestrator/`, `src/http-listener/`,
`src/notebook/`. Creates the namespace where Phase 5 cutover glue
will land. `src/index.ts` (Telegram bot entry) is untouched.

**Q2 — Transaction boundaries.** No cross-method transactions.
`appendHookEvent` is a single INSERT (implicit SQLite tx).
`backfillHookEvents` is a single UPDATE (implicit tx). The
correlator's three-path backfill (eager `recordHook`, lazy
`registerSession`, final `retireJob`) provides the eventual
consistency guarantee; wrapping INSERT + UPDATE in one tx would
require a cross-layer begin/commit seam with no added guarantee.
Rationale is inlined as comments on both method bodies.

**Q3 — E2E subprocess shape.** `claude -p "Say hi."` via
`child_process.spawn`, using the `--settings <file>` CLI flag (not
`CLAUDE_CONFIG_DIR`, not `HOME` override — `--settings` is the
cleanest per-subprocess isolation, confirmed present in CC 2.1.116).
stdout piped into the orchestrator's `captureWorkerSessionId` via
the `{ stdout }` WorkerHandle. `subprocess.on("exit")` handler calls
`notebook.updateStatus(job.id, "completed")` to terminate the child
job the orchestrator is awaiting. Test timeout 60s. afterEach kills
subprocess (SIGKILL if `exitCode === null`), stops listener, removes
tmpdir. Post-exit 5s settle-window polls `hook_events` before
asserting, since sync hooks block CC until 200 but small timing
windows remain around subprocess exit and `retireJob`.

**Q4 — Port selection.** Ephemeral via the existing `getFreePort()`
pattern from `src/http-listener/listener.test.ts`. Decouples the e2e
test from Gate-1 state, avoids colliding with a production listener
on 8787. Fixed 8787 is reserved for the production path, which
Phase 5 will activate.

### 4. Deviations from the kickoff spec

- **D5 — settings.json registration DEFERRED to Phase 5**, with
  Tren's explicit approval in chat. No file was created or modified
  under `~/miracle-workspace/`. Rationale: `~/miracle-workspace/.claude/settings.json`
  did not previously exist; creating it before Phase 5 starts a real
  listener on 8787 would add ~4ms overhead per live-bot claude
  subprocess (empirically measured: connection-refused is fail-fast
  on localhost, ~1ms per hook attempt × 4 registered events) plus
  stderr log noise in `/tmp/com.miracle.bot.err`, with no benefit
  until Phase 5's listener starts. Deferring is reversible; creating
  then reverting would be a file deletion on a live-accessed path.

- **D3 — InMemoryNotebookClient tightening was a NO-OP.** The
  phase-3-merge-report.md:35 flag ("parameter currently omits
  `receivedAt`") is inaccurate against current HEAD. Current impl at
  `src/notebook/client.ts:145–155` already declares all four fields
  (`sessionId`, `eventType`, `payloadJson`, `receivedAt: number`).
  Git log confirms this has been the shape since the C5 WIP commit
  `2a50502`; the merge-report claim was written against a state that
  never landed. Marked complete, no code change.

- **Hook-settings schema.** INTERFACES.md §194–205 sketches a flat
  top-level `"hooks": [{...}]` array. CC 2.1.116 actually parses the
  nested-by-event-name schema (`"hooks": { "SessionStart": [{...}] }`).
  The e2e test uses the nested schema; it worked on first live run.
  Flag for the INTERFACES.md §194–205 correction commit that happens
  post-C8 merge.

### 5. Unhandled edge cases / best-effort surfaces

- **SessionStart does NOT fire for `claude -p` runs.** Empirical
  observation from the passing e2e: only `UserPromptSubmit`, `Stop`,
  `SessionEnd` landed in `hook_events`. SessionStart fires only for
  interactive sessions. The e2e's four-event registration handles
  this naturally; nothing to fix, but a note for Phase 5 planning.

- **Hook-during-subprocess-exit race.** Mitigated with 5s settle
  window in the e2e. Fundamentally unavoidable for async hooks; sync
  hooks (default per INTERFACES.md §201–203) block CC until 200, so
  the race is tight but real if any hook is `async: true`.

- **sessionCapture is fire-and-forget.** `runOrchestrator` at
  `src/orchestrator/index.ts:99` calls `void captureWorkerSessionId(...)`.
  If the worker exits before sessionCapture finishes reading stdout,
  `registerSession` never fires and `retireJob`'s final backfill is a
  no-op (correlator has no mapping). Eager-path hooks (POSTs arriving
  after registerSession + before retireJob) are backfilled via
  `recordHook`. Rows that POST before registerSession and subprocess
  exits fast enough to skip sessionCapture → stay NULL. This is the
  intended best-effort contract per `correlator.ts:32–37`.

- **observeCompletions polls every 10ms.** `src/notebook/client.ts:34,337`.
  For a 10s claude run the e2e burns ~1000 queries. Acceptable; do
  not change production polling interval just for the e2e.

### 6. Phase 4 coordination-point cleanup items

These are for the orchestration thread to handle post-merge:

- **INTERFACES.md §194–205 needs correction.** The top-level flat
  `"hooks": [{...}]` shape is obsolete; CC 2.1.116 uses nested-
  by-event-name. Reflect in the spec before Phase 5.

- **INTERFACES.md §467–481 (Phase 5 — Cutover) understates Phase 5's
  scope significantly.** See §8c below for the corrected scope list.
  Update before `phase-4-complete` tags.

- **phase-3-merge-report.md:35 claim is stale.** `InMemoryNotebookClient.appendHookEvent`
  was never narrower than the interface against what actually landed
  in tier-3. Consider annotating the merge report or leaving as
  historical artifact.

- **No C4 bugs found via the e2e.** The live-chain run exercised
  `captureWorkerSessionIdFromLines`, `LiveCorrelator.registerSession`,
  `recordHook`, `retireJob`, and the listener's eager-path call into
  recordHook — all behaved correctly. Final state in
  `~/.miracle/tier-3-test.db` showed 3 rows all with `job_id` set to
  the expected orchestrator-subtask id.

### 7. Phase 5 readiness

#### (a) Runtime launch, flag consumer, launchd paths (already surfaced in chat)

- **Production launch:** Recommend Option A — integrate
  `createTier3Runtime()` into `bot/src/index.ts` behind a
  `loadEnv().tier3Enabled` check at startup. When true: construct
  runtime with a SqliteNotebookClient pointing at `~/.miracle/queue.db`,
  call `listener.start()`, route incoming Telegram messages through
  `runtime.runJob(ask)`. Single binary, single launchd job. Options B
  (new launchd job) and C (plist-level flag selection) fragment the
  deploy surface.

- **TIER_3_ENABLED consumers today:** exactly three, none
  functional: `src/config/env.ts:18` (reader), `src/config/env.test.ts`
  (tests the reader), `launchd/com.miracle.bot.plist:25` (bundled
  plist template, NOT deployed). Runtime code has zero `loadEnv()`
  call sites. **Flipping the flag is a no-op today.** Phase 5 must
  add a consumer (per Option A above) — that's implementation work,
  contradicting INTERFACES.md §470's "no implementation work."

- **Launchd paths and branches:**

  | Job | WorkingDirectory | Branch |
  |---|---|---|
  | `com.miracle.bot` | `/Users/genesisai/Projects/miracle/bot` | `miracle-mvp` @ `2ccc025` |
  | `com.miracle.digest` | `/Users/genesisai/Projects/miracle` | (loose dir, not a git worktree) |
  | `com.miracle.aunt-cam-bot` | `/Users/genesisai/miracle-workspace/projects/aunt-cam-prep/bot` | (separate project, unrelated) |

  Merging `tier-3 → main` doesn't reach production; the live bot is
  on `miracle-mvp` at SHA `2ccc025`. See §(c) for branch strategy.

#### (b) Findings from the ten investigations

**Angle 1 — MVP bot architecture (what Tier 3 is replacing).**

The MVP bot (at `~/Projects/miracle/bot`, branch `miracle-mvp`) runs
grammY with a single global `ClaudeSession` instance. Request
lifecycle today: Telegram message → grammY dispatch → handler (e.g.
`text.ts`) → auth/rate-limit check → `session.sendMessageStreaming(...)`
→ spawn `claude -p --output-format stream-json --include-partial-messages --dangerously-skip-permissions`
in `WORKING_DIR` (= `/Users/genesisai/miracle-workspace`) → parse
NDJSON events from stdout → status callback → Telegram reply.

Claude-CLI call sites (all via `bot/src/session.ts:377`): exactly one
`spawn(CLAUDE_CLI_PATH, args, {...})`. Other files reference `claude`
in comments or imports only (grep matches at `index.ts`, `config.ts`,
`handlers/document.ts`, `secrets.ts`, `handlers/voice.ts`,
`handlers/audio.ts`, `autodoc.ts`).

`bot/src/` does NOT touch `~/.miracle/`. Grep returned no matches.
Bot persists only to `STATE_FILE`, `SESSION_FILE`, `RESTART_FILE` (all
under `/tmp/` per `src/config.ts`).

Bot tests: **none in `bot/src/`**. Tests exist under `bot/tests/`
(commands, formatting, registry, secrets, security, signature) —
same set as tier-3-build's tests because the two repos have diverged
from a common ancestor. These tests do not exercise ClaudeSession
spawn behavior; replacement by Tier3Runtime will not break them.

**Angle 2 — In-flight state during cutover.**

Durable writes in `bot/src/`:
- `session.ts:131` — `/tmp/claude-telegram-bot-state.json` (working dir, last session id)
- `session.ts:753` — `/tmp/claude-telegram-session.json` (session history, last 5)
- `handlers/streaming.ts:77` — `/tmp/telegram-bot/` (askUser MCP request files)
- `handlers/commands.ts:360` — `/tmp/claude-telegram-bot-restart.json` (restart-message UID)
- `handlers/{voice,audio,photo,document,video}.ts` — `/tmp/` media drops
- `vault-search.ts:53` — readonly open of the vault sqlite

No durable in-flight-request tracking. **If com.miracle.bot restarts
mid-request, the in-flight claude subprocess is killed by launchd**
(PID group dies with the parent), the grammY sequentializer drops
the queued message, Telegram retries at the platform layer if the
bot didn't ack — the user sees nothing, message is lost silently.

Stash `stash@{0}` on `miracle-mvp`: "pre-tier-3 WIP stash:
keychain+n8n+node-port finalization, findClaudeCli cleanup,
GSD_OPERATIONS=19 test fix". Touches `package.json` (removes
`dotenv`), `src/config.ts` (POSIX-compatible `which claude` fallback
replacing `where claude`), `src/handlers/callback.ts` (two empty
catch-block comments). Informational only — kickoff says don't pop
until Phase 6.

Retry / resume patterns in `bot/src/`: 15 files match. Most are UI-
level ("retry button", "resume session") rather than durable-state
recovery. No file-level transaction logic that would paper over a
mid-request restart.

**Conclusion:** cutover with an in-flight Telegram request drops
that request. Recommendation: post a `/status` check via Telegram
before and after the flip; tell users if there's a live conversation
to wait until it completes.

**Angle 3 — Rollback plan.**

Tier 3 code writes state in **two places only**:
- `~/.miracle/queue.db` (SqliteNotebookClient, when the runtime is
  constructed with that path)
- `~/.miracle/tier-3-test.db` (the e2e test, untouched by production)

No writes under `~/miracle-workspace/` (since Gate 1 deferred). No
launchd writes. No keychain writes. No writes to the user's real
`~/.claude/` settings. Production DB `~/.miracle/queue.db` currently
does NOT exist (confirmed via stat); it will only be created once
Phase 5 constructs a runtime against it.

Rollback commands (proposed — Phase 5 should formalize as a script):

```bash
# 1. Flip flag off and restart
plutil -replace EnvironmentVariables.TIER_3_ENABLED -string "false" \
  ~/Library/LaunchAgents/com.miracle.bot.plist
launchctl kickstart -k gui/$(id -u)/com.miracle.bot

# 2. Revert the merge (prefer git revert for a shared branch)
cd ~/Projects/miracle/bot
git revert -m 1 <merge-commit-sha>  # safer than reset for shared history
launchctl kickstart -k gui/$(id -u)/com.miracle.bot

# 3. Optional cleanup — remove Tier 3 state (only if confidence is
#    low that MVP will reopen the DB cleanly)
rm -f ~/.miracle/queue.db ~/.miracle/queue.db-journal \
      ~/.miracle/queue.db-wal ~/.miracle/queue.db-shm

# 4. Undo Gate 1 (only if Phase 5 created it and rollback is
#    post-Gate-1)
mv ~/miracle-workspace/.claude/settings.json.pre-tier-3-backup \
   ~/miracle-workspace/.claude/settings.json  # or remove if no backup
```

`git revert -m 1` is safer than `git reset --hard` because
`miracle-mvp` is a shared/live branch; revert preserves history and
lets `launchd` restart pick up the revert commit without force-push
surgery.

**Angle 4 — SQLite concurrency.**

Grep for `journal_mode|WAL|busy_timeout|PRAGMA|pragma` in
`tier-3-build-c8/src/` returned **zero matches**. `SqliteNotebookClient`
opens better-sqlite3 with `new Database(this.dbPath)` (no options) at
`client.ts:214` and runs the migration — no `PRAGMA journal_mode = WAL`,
no `busy_timeout` tuning.

Production pattern: listener writes `hook_events` (single INSERT per
hook), orchestrator reads + updates `jobs` (reads are typical;
`updateStatus` UPDATEs). Both paths come from the same Node process
(Tier3Runtime composes them), so better-sqlite3's single-thread
serialization handles in-process concurrency.

**Cross-process:** if another process ever opens `~/.miracle/queue.db`
(read-only vault search, shell inspection, future digest module),
default journal mode (`DELETE`) locks out readers during writes.
With realistic hook volume (a few POSTs per session), lock contention
would be brief but visible as `SQLITE_BUSY` errors on the reader.

**Recommendation:** Phase 5 pre-cutover commit should add a `PRAGMA
journal_mode = WAL` and `PRAGMA busy_timeout = 5000` in
`SqliteNotebookClient` constructor at `client.ts:214`, right after
`this.db = new Database(...)`. WAL mode permits concurrent reads
during writes without `SQLITE_BUSY`, and `busy_timeout` gives any
remaining writers breathing room. One-line change each; tests
already cover reopen behavior which would catch WAL-sidecar issues.

**Do not change in C8.** This is Phase 5 readiness work.

**Angle 5 — E2E vs production environment mismatch.**

- **Correlator in-memory maps are unbounded.** Grep for
  `prune|MAX_|limit|evict|cleanup|expire` in `src/correlation/`
  returned zero matches. `LiveCorrelator.sessionToJobId` and
  `jobToSessionId` grow indefinitely until `retireJob` clears an
  entry. Terminal-status jobs always call retireJob, so growth is
  bounded by concurrent-session count. But if sessionCapture fires
  `registerSession` and the job somehow never reaches terminal
  status (orchestrator crash, killed child), the entry leaks.
  **Phase 5 readiness item:** add a size cap + LRU eviction, or
  periodic pruning keyed on job age. Low-priority; production
  session count is low (single user on a Mac mini).

- **hook_events is append-only.** No TRUNCATE / DELETE / prune
  logic anywhere. At modest usage (say 50 hooks per session × 20
  sessions/day = 1000 rows/day, ~300 bytes/row payload = 300KB/day),
  disk growth is negligible (~110MB/year). At heavier usage, monthly
  VACUUM or a retention policy (DELETE WHERE received_at <
  now - 30d) would be appropriate. **Phase 5 readiness item,
  low-priority.**

- **Mac mini reboot / orchestrator restart:** per
  `correlator.ts:30–37` (quoted verbatim):

  > Phase 4 keeps correlation state in memory on purpose.
  > Recovery design call: if the orchestrator restarts mid-session,
  > existing live mappings are lost. Already-written hook rows
  > remain in the notebook, but any rows that never get re-associated
  > by a later registerSession call may stay NULL forever. That is
  > acceptable under the best-effort contract for hook_events.job_id.

  Documented and intentional. No action.

**Angle 6 — Three-branch situation.**

| Branch | SHA | Role |
|---|---|---|
| `main` | `5cd9d9b7732eb6310c3ee92657d6423c4045e9ff` | untouched since MVP v1.0.0 ship; nothing runs from it |
| `miracle-mvp` | `2ccc0253122453d6f682b4ced801b0318ec69d64` | live bot's branch (runs via `com.miracle.bot`) |
| `tier-3` | `6318199555b66fed02acb398390a11287b54e28a` | current Tier 3 build |

`git log main ^miracle-mvp` shows `main` is an ancestor of
`miracle-mvp`: nothing on `main` that isn't on `miracle-mvp`, but
`miracle-mvp` has `2ccc025` and `66b0d50` ahead of `main`. So `main`
runs literally nowhere in production.

**Recommendation — Option A:** merge `tier-3 → miracle-mvp`, leave
`main` untouched. Rationale: the live bot runs from `miracle-mvp`;
that's the only branch the cutover needs to touch. Merging into
`main` AND `miracle-mvp` is double-work with no benefit, and
merging only into `main` requires a follow-up step to checkout
`main` in the bot worktree (fragile).

Option B (merge to main, checkout main in bot worktree) is
reasonable but requires remembering the checkout step. Option C
(merge to both) wastes reviewer cycles. Pick Option A.

Phase 5 sequencing:
1. Add TIER_3_ENABLED consumer commit to `tier-3` (or a new
   `tier-3-c9` sub-branch) before sealing phase-4-complete.
2. Merge `tier-3 → miracle-mvp` with standard review.
3. Deploy steps (§c).

**Angle 7 — miracle-workspace blast radius.**

Processes / humans using `~/miracle-workspace/` as CC cwd:

| Context | CLAUDE_WORKING_DIR or cwd = miracle-workspace? |
|---|---|
| `com.miracle.bot` → `session.ts` spawn | **Yes** (`CLAUDE_WORKING_DIR=~/miracle-workspace` env var, used as spawn cwd) |
| `com.miracle.digest` → `digest.ts` spawn | **Yes** (`cwd: MIRACLE_WORKSPACE` at line 157) |
| `com.miracle.aunt-cam-bot` → `main.py` | **No** — cwd is `~/miracle-workspace/projects/aunt-cam-prep/bot` (deeper subtree), and aunt-cam-bot does not spawn claude at all (python-telegram-bot only) |
| Interactive user sessions | Unknown — ask Tren; likely yes on occasion |

`~/miracle-workspace/` is **not under git** — no `.git` directory.
It contains `CLAUDE.md` (3144 bytes, last mod 2026-04-18) and
`projects/` (aunt-cam-prep, genesis-ai-systems.md, hub-365.md,
prosperous-collection.md) plus `openmemory/` and `.claude/` (agents
only).

**Implication:** landing settings.json (Gate 1, Phase 5) affects
both `com.miracle.bot` and `com.miracle.digest` claude subprocesses
plus any interactive `claude` you run from that dir. All three will
POST to 127.0.0.1:8787 on each hook event. After Phase 5 starts a
production listener on 8787, those POSTs become load-bearing. Before
that, they're fail-fast connection-refused (~1ms each).

Digest's 25s timeouts on claude modules are generous; adding ~4ms of
failed-hook overhead has no material impact.

**Angle 8 — Listener security.**

`src/http-listener/listener.ts:33`:
```typescript
this.app.post("/hook", (req, res) => {
  void this.handleHook(req, res);
});
```

**No authentication.** `/hook` accepts any POST body with any
content-type (the express.text middleware at line 27 uses
`type: () => true` to capture raw body).

**Bind address.** Runtime default at `src/tier3/runtime.ts:62` is
`host: config.host ?? "127.0.0.1"`. Listener binds via
`this.app.listen(this.config.port, this.config.host, ...)` at
`listener.ts:42` — the host from config is passed straight through
to Node's `app.listen`. Enforcement is at **caller layer** (runtime
default of 127.0.0.1), not in the listener itself. A malicious or
mistaken caller could pass `"0.0.0.0"` and expose /hook to the LAN.

**Recommendation (do NOT execute):** for Phase 5 production, either
(a) tighten the listener to reject any non-loopback host in
`ExpressHttpListener.start()`, OR (b) accept the "config layer
enforces loopback" contract and document it. On a single-user Mac
mini with no inbound firewall rules for 8787, the blast radius of
an accidental 0.0.0.0 bind is still the loopback-only physical
interface exposure — low real-world risk but worth a defense-in-
depth commit.

**Verdict:** no auth is acceptable for a single-user local Mac
mini. Document the reasoning explicitly in INTERFACES.md before
phase-4-complete.

**Angle 9 — Observability post-cutover.**

`src/tier3/runtime.ts` contains **no console.log / logger calls at
all**. Grep returned zero matches. Runtime startup is silent.
`ExpressHttpListener` logs only warnings (malformed payloads) and
errors (notebook write failures) via `this.logger` which defaults to
`console`.

**Phase 5 readiness gap:** add a startup log line "Tier 3 runtime
listening on 127.0.0.1:8787" so bot stdout (in `/tmp/com.miracle.bot.out`)
confirms the runtime actually started. One-line change to
`Tier3Runtime.listener.start()` wrapper or to runJob's first call.

**"Is Tier 3 active right now?" queries:**

```bash
# Recent jobs (last 10)
sqlite3 ~/.miracle/queue.db "SELECT id, kind, status, datetime(created_at/1000, 'unixepoch', 'localtime') FROM jobs ORDER BY created_at DESC LIMIT 10;"

# Recent hooks (last 10)
sqlite3 ~/.miracle/queue.db "SELECT event_id, job_id IS NOT NULL AS correlated, event_type, datetime(received_at/1000, 'unixepoch', 'localtime') FROM hook_events ORDER BY event_id DESC LIMIT 10;"

# Count since last hour
sqlite3 ~/.miracle/queue.db "SELECT COUNT(*) FROM hook_events WHERE received_at > (strftime('%s', 'now') - 3600) * 1000;"

# Is port 8787 bound? (from shell, no DB needed)
lsof -iTCP:8787 -sTCP:LISTEN
```

**Proposed 30-second smoke test (Phase 5 cutover execution):**

```bash
# (0) Pre-flight: confirm port free, DB absent
lsof -iTCP:8787 -sTCP:LISTEN  # expect empty
test ! -f ~/.miracle/queue.db && echo "DB not yet created (expected)"

# (1) Flip flag + restart
plutil -replace EnvironmentVariables.TIER_3_ENABLED -string "true" \
  ~/Library/LaunchAgents/com.miracle.bot.plist
launchctl kickstart -k gui/$(id -u)/com.miracle.bot
sleep 3

# (2) Confirm listener bound + DB created
lsof -iTCP:8787 -sTCP:LISTEN  # expect com.miracle.bot owning 8787
test -f ~/.miracle/queue.db && echo "DB created"
grep "Tier 3 runtime listening" /tmp/com.miracle.bot.out | tail -1

# (3) Send a known Telegram message (via your phone, any short prompt)
#     Wait ~10 seconds for CC round-trip

# (4) Assert the chain
sqlite3 ~/.miracle/queue.db "SELECT COUNT(*) FROM jobs;"           # >= 2 (orchestrator + subtask)
sqlite3 ~/.miracle/queue.db "SELECT COUNT(*) FROM hook_events WHERE job_id IS NOT NULL;"  # >= 1
sqlite3 ~/.miracle/queue.db "SELECT COUNT(*) FROM hook_events WHERE job_id IS NULL;"      # ideally 0

# If all counts look right: cutover succeeded. If not: rollback (§3).
```

**Angle 10 — Digest and aunt-cam-bot side effects.**

- **com.miracle.digest** spawns claude subprocesses. `digest.ts:44`
  sets `MIRACLE_WORKSPACE = "/Users/genesisai/miracle-workspace"`,
  and line 157 confirms `cwd: MIRACLE_WORKSPACE` for module-4 claude
  spawn. Modules 4, 5, 6 all shell out to `claude`. After Phase 5's
  Gate 1 create, these spawns will POST to 8787 on each hook event.
  With a live listener, their hook_events rows will land in the same
  `~/.miracle/queue.db`. **These are NOT orchestrator-tracked jobs**
  — nothing calls `createJob` / `runOrchestrator` for digest's claude
  invocations, so their session_ids will never match a jobId in the
  correlator's in-memory map, and hook_events rows from digest stay
  with `job_id = NULL` forever (correctly per the best-effort
  contract — they're just uncorrelated ambient traffic).

  **Disk-growth implication:** digest runs daily at 08:00 EDT, fires
  maybe 10–15 hooks per run × 3 modules = ~30-45 NULL rows/day in
  production. Trivial.

  **Recommendation:** accept it. Document in the Phase 5 cutover
  commit that hook_events includes uncorrelated ambient hooks from
  digest's claude sessions, and that `WHERE job_id IS NOT NULL` is
  the filter for orchestrator-tracked events.

- **com.miracle.aunt-cam-bot** does NOT spawn claude at all. Its
  `main.py` uses `subprocess.run([..."security", "find-generic-password"...])`
  for keychain lookup only. No claude invocations. Unaffected by any
  Phase 5 change. Different cwd (aunt-cam-prep/bot subtree).

#### (c) Corrected Phase 5 scope list

INTERFACES.md §467–481 currently states Phase 5 is "no
implementation work, no new components, no spec changes" and lists
only three items: flip flag, merge, tag. **This is incorrect.**
Per the investigations above, Phase 5 actually needs:

1. **[implementation]** Add TIER_3_ENABLED consumer in bot entry
   point. Without this, flipping the flag is a no-op.
   (Per Option A: wire `createTier3Runtime()` into `bot/src/index.ts`.
   Phase 5 readiness work — consider landing as `tier-3-c9` before
   `phase-4-complete` tags, so Phase 5 stays "narrow" semantically.)
2. **[pre-cutover]** `PRAGMA journal_mode = WAL` + `PRAGMA busy_timeout = 5000`
   added to `SqliteNotebookClient` constructor. One-line change;
   improves cross-process safety.
3. **[optional readiness]** Add a startup log line in Tier3Runtime
   so cutover observability is non-silent.
4. **[optional readiness]** INTERFACES.md corrections (§194–205 hook
   shape; §467–481 Phase 5 scope; §Angle 8 listener-auth reasoning).
5. **[cutover]** Create `~/miracle-workspace/.claude/settings.json`
   with nested hook registration pointed at 8787 (the Gate 1 delta
   deferred here). Back up to `.pre-tier-3-backup`.
6. **[cutover]** Merge `tier-3 → miracle-mvp` (NOT `main`). Merge
   strategy: standard merge commit, no squash.
7. **[cutover]** Edit live plist `~/Library/LaunchAgents/com.miracle.bot.plist`
   to add `<key>TIER_3_ENABLED</key><string>true</string>`.
8. **[cutover]** `launchctl kickstart -k gui/$(id -u)/com.miracle.bot`.
9. **[verification]** Run the 30-second smoke test (§Angle 9).
10. **[tag]** Tag `phase-5-complete` on `miracle-mvp` at the merge
    commit (NOT on `main`; correct the spec note as well).

### 8. Final verification

- `cd ~/Projects/miracle/tier-3-build-c8 && git status --porcelain` → empty
- `git rev-parse HEAD` → `4846f58eca26306e096d234787beebc6c3e5e71d`
- `bun run typecheck` → green (tsc --noEmit, exit 0)
- `npm test` → 157 passed, 1 skipped (18 test files passed, 1 skipped)
- `E2E=1 npm test` → 158 passed (19 test files), 7.19s total (e2e run took 4.24s on first try, hook_events DB final state: 3 rows all correlated with child job)
- `launchctl list | grep miracle` → all three jobs still present at
  same labels (com.miracle.aunt-cam-bot, com.miracle.bot, com.miracle.digest); no modifications
- `stat ~/.miracle/queue.db` → **does not exist** (production DB
  untouched, Tier 3 hasn't been flipped on)
- `stat ~/.miracle/tier-3-test.db` → mtime `Apr 21 03:14:06 2026`
  (written by the e2e run; isolated from production)
- `ls ~/miracle-workspace/.claude/` → only `agents/` subdir, no
  settings.json (Gate 1 deferred, confirmed no write)
- `cd ~/Projects/miracle/bot && git status --porcelain` → empty
  (MVP bot worktree untouched)
- `phase-2-complete`, `phase-3-complete` tags: not touched

### 9. Merge notes

Branch `tier-3-c8` is at `4846f58`, 3 commits ahead of the
`6318199` fork point. No conflicts expected on merge to `tier-3`
(only touched files are `src/notebook/client.ts`, `src/notebook/sqlite.test.ts`,
and three new files under `src/tier3/` and `tests/e2e/`; none of
those surfaces have other branches in flight).

