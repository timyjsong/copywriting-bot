# Session Continuity

Updated: 2026-05-14T19:35:30Z

## Current State

- Iteration: 24
- Phase: PHASE_2_PAID_FLOW
- RARV Step: VERIFY
- Provider: claude
- Elapsed: 4h 30m

## Last Completed Task

- Iter 24: extended `emitFunnelEvent` helper with optional `dedupKey` → stamps
  PostHog `$insert_id` so a retried Inngest step (e.g. transient PostHog 5xx)
  collapses on PostHog's 24h dedup window instead of double-counting the
  conversion. Same iter-21/23 pattern, applied at the helper layer so all
  three remaining server-emitted funnel events inherit it uniformly:
    - `rewrite_approved` keyed on `approval_id`
    - `sequence_activated` keyed on `first_batch_id`
    - `performance_report_sent` keyed on `${campaign_id}:${snapshot_date}`
  Helper preserves the no-key fast path (reference-equality on props) for
  backwards compat. Pinned 7 new contracts in `_funnel.test.ts` (key format,
  cross-event collision guard, retry-produces-same-id, different-entities-
  produce-different-ids, no-mutation invariant, reference-equality fallback,
  empty-string `dedupKey` boundary). Three pipeline-level assertions updated
  to lock the per-event key. All 435 tests pass; typecheck clean.

## Active Blockers

- None

## Next Up

- PostHog funnel tracking (one event left without dedup pin?
  audit `serverPosthog.capture` callsites for any stragglers)
- Ship to production
- Stripe Checkout integration ($297 one-time)

## Key Decisions This Session

- Dedup `$insert_id` belongs at the `emitFunnelEvent` helper layer, not at
  each caller, so future server-emitted events inherit the contract by
  default. Optional `dedupKey` param keeps no-key fast path intact for
  callers whose step has no retry surface.
