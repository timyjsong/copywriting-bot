# Session Continuity

Updated: 2026-05-14T17:36:00Z

## Current State

- Iteration: 10
- Phase: PHASE_2_PAID_FLOW
- RARV Step: VERIFY
- Provider: claude
- Elapsed: 2h 31m

## Last Completed Task

- Last commit: Loki iter 10: DI seam for inngest pipelines + structural test-utils split
- Files changed: packages/inngest/src/functions/_db.ts (new), _campaigns.ts, _funnel.test.ts (new),
  _campaigns.test.ts (new), onboarding.ts, sendBatch.ts, performance.ts,
  funnel-events-edge.test.ts, test-utils/supabase-fake.ts (new, moved from functions/_test-fakes.ts)
- Tests: 292 passing (+13 from iter 9: 11 new helper-unit tests + load-sequence null-data parity test + null-count branch lock)

## Active Blockers

- None

## Next Up

- PostHog funnel tracking (PRD-011)
- Ship to production (PRD-012)
- Stripe Checkout integration $297 one-time (PRD-013)

## Key Decisions This Session

- **DI seam (iter 10):** `runOnboardingPipeline` / `runSendBatchGenerate` / `runPerformanceDailyPull`
  now accept `db?: DbPort` via ctx; tests inject a fake directly, eliminating
  `vi.mock("@copywriting-bot/db/client")` in `funnel-events-edge.test.ts`. Closes
  iter 7→9 architecture-strategist "pure functions still call serviceClient internally" finding.
- **Test-utils structural split (iter 10):** Supabase + step fakes moved from
  `src/functions/_test-fakes.ts` to `src/test-utils/supabase-fake.ts` so the
  vitest import is sibling-folder-isolated, not just `_` prefixed.
- **DbPort port type (iter 10):** `type DbPort = ReturnType<typeof serviceClient>`
  in `_db.ts` — used by `_campaigns.ts` (replacing the inline re-coupling) and
  all three pipeline ctx types.
- **Fake `.then()` idempotency (iter 10):** Added `recorded_once` flag to the
  Supabase fake builder so re-awaiting the same builder doesn't double-push
  to `recorded.*`.

## Mistakes & Learnings

- TS strict + `noUncheckedIndexedAccess` requires `!` non-null assertions when
  indexing `Record<string, T[]>` — caught at typecheck on edge-test asserts.
- `inngest` package does NOT directly depend on `@supabase/supabase-js`; importing
  `SupabaseClient` directly would force adding the dep. `ReturnType<typeof serviceClient>`
  derives the same type via the workspace `@copywriting-bot/db/client` re-export.
- The captureServerEvent mock needs explicit arg types (`vi.fn(async (a, b, c) => ...)`)
  for `mock.calls[0]![2]` to be typed instead of `unknown[]`.
