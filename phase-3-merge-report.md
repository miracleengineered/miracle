# Phase 3 Merge Report

Tier 3 architecture, Phase 3 sub-branches (C3 worker protocol, C5 HTTP webhook
hooks, C6 model routing) merged into `tier-3`.

Starting trunk: `513e363` (tier-3: correct phase 3 jobs schema with missing
Job fields).

Merge order: C3 → C5 → C6.

---

## C3 — SqliteNotebookClient (worker protocol persistence)

- **merge_commit:** 73bf6216f17a4ff5b63a3ff2cede55c64744edf2
- **timestamp:** 2026-04-21T02:33:30Z
- **tsc:** pass (exit 0)
- **npm_test:** pass (exit 0), 128 tests total
- **sub-branch head merged:** 33856f9
- **scope_observations:** none observed — changes limited to `src/notebook/client.ts` (SqliteNotebookClient impl + migration-on-first-boot) and `src/notebook/sqlite.test.ts`; no touches to trunk-landed types or migration DDL.

---

## C5 — HTTP webhook listener (loopback Express, log-only)

- **merge_commit:** 7e004910e806dc7643d0d823572ed19c9b6b69ec
- **timestamp:** 2026-04-21T03:10:16Z
- **tsc:** pass (exit 0)
- **npm_test:** pass (exit 0), 130 tests total
- **sub-branch head merged:** f5cc264
- **merge_base:** 513e363
- **conflict:** src/notebook/client.ts, single region in SqliteNotebookClient class (original lines 315–398). Resolved by keeping HEAD (C3's real observeCompletions/readJob/getTerminalChildren) and discarding C5's stale throwing-stub appendHookEvent. Matches kickoff coordination point 1 predicted end state.
- **install_note:** bun install required in integration worktree after merge to populate @types/express in node_modules — manifest and lockfile arrived via merge but node_modules was stale. Not a scope deviation; standard bun-worktree hygiene. Flag for future integration worktrees.
- **interface_tightening:** appendHookEvent? kept OPTIONAL per kickoff coordination point 3. Tightening to required would require a real SqliteNotebookClient implementation (needs hook-events schema), which is out of Phase 3 scope. Deferred to Phase 4+.
- **scope_observations:** new src/http-listener/listener.ts + listener.test.ts as expected; package.json adds express + @types/express; InMemoryNotebookClient.appendHookEvent parameter type narrower than interface (omits receivedAt) — runtime-correct via spread, flagged for Phase 4+ cleanup.

---

## C6 — Model routing (orchestrator dispatch integration)

- **merge_commit:** 6b21897485dcdbbb3990be4306e7b598ec71402d
- **timestamp:** 2026-04-21T03:21:59Z
- **tsc:** pass (exit 0)
- **npm_test:** pass (exit 0), 133 tests total
- **sub-branch head merged:** a325ce2
- **merge_base:** 3402a60 (C6 forked from original pre-kickoff; 513e363 schema-correction landed only on trunk)
- **conflict:** none — clean `ort` merge across 5 files, all in expected scope
- **install_note:** no new deps; `bun install` reported "no changes" across 213 installs / 259 packages
- **scope_observations:** routing-table.json populated with both production kinds (orchestrator → opus, orchestrator-subtask → sonnet); orchestrator dispatch wired via src/orchestrator/index.ts (+3) and types.ts (+3) with 50 new orchestrator.test.ts lines; no touches to C3's notebook client or C5's http-listener surface.

---

## Coordination-point cleanup

- **timestamp:** 2026-04-21T03:36:01Z

### Coordination point 2 — InMemory cancelled-status parity (FIXED)

- **commit:** e8b3ebd56bc2f4be0bf2124f07eaa221145d8f58
- **summary:** InMemoryNotebookClient.updateStatus and .observeCompletions previously hardcoded `{completed, failed}` as terminal, predating Phase 3's addition of `cancelled` to JobStatus. Routed both sites through the existing file-scope `isTerminalStatus` helper (src/notebook/client.ts:~454), which SqliteNotebookClient already uses. Two-line change; zero new imports.
- **test coverage:** added sibling cancelled-case test mirroring existing completed/failed coverage (src/notebook/client.test.ts), test count 134.

### Coordination point 3 — appendHookEvent? interface tightening (DEFERRED, corrected rationale)

- **decision:** kept OPTIONAL on NotebookClient interface. Deferred any tightening indefinitely, not just to Phase 4+.
- **corrected rationale (supersedes C5 merge report note):** The C5 merge report claimed tightening requires "hook-events schema work" — that claim was stale. The `hook_events` table is created at SqliteNotebookClient construction time via `this.db.exec(MIGRATION_SQL)` (migrations/001_phase3_init.sql line 26), so the schema is live. The actual reason to leave the interface optional is architectural: the current optional-at-interface + `Required<Pick<NotebookClient, "appendHookEvent">>`-at-caller pattern (see src/http-listener/listener.ts line 8, `HookEventNotebookClient`) is correct design. It precisely expresses "not every notebook backend supports hooks; callers that need hooks narrow at their boundary." Tightening would force every backend to declare a method it may not need, or add throw-stubs (strictly worse — converts compile-time errors to runtime errors).
- **current state:** only one production call site (ExpressHttpListener at src/http-listener/listener.ts:75), already type-narrowed via HookEventNotebookClient. No silent no-op risk. A future integration wiring a Sqlite backend to ExpressHttpListener will fail at compile time, forcing the integrator to add a proper Sqlite implementation (with tests) at that point — which is the right place for that work, not Phase 3 cleanup.
- **Phase 4+ note:** when Sqlite-to-hooks integration lands (C8 or later), implement appendHookEvent on SqliteNotebookClient as a real INSERT into hook_events (job_id NULL per current contract, correlation deferred per INTERFACES.md). Do not tighten the interface at that time either — the pattern stays optional.

---
