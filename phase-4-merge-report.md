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
