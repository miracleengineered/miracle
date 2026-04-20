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
