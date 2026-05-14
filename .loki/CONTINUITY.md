# Session Continuity

Updated: 2026-05-14T19:15:00Z

## Current State

- Iteration: 21
- Phase: PHASE_2_PAID_FLOW
- RARV Step: VERIFY
- Provider: claude
- Elapsed: 4h 13m

## Last Completed Task

- Last commit: Loki iter 21: dedup dual-emission funnel events via $insert_id
- Files changed:
  - packages/shared/src/funnel-keys.ts (new, zero-deps)
  - packages/shared/src/funnel.ts (re-exports funnelInsertId)
  - packages/shared/src/observability.ts (re-export, type moved)
  - packages/shared/src/funnel.test.ts (+5 tests for funnelInsertId)
  - packages/shared/package.json (./funnel-keys subpath)
  - packages/inngest/src/functions/roast.ts (DI seam + $insert_id)
  - packages/inngest/src/functions/roast.test.ts (new, 5 tests)
  - apps/web/app/posthog-client.ts (zero-deps type import)
  - apps/web/app/roast/page.tsx ($insert_id on viewed_result)
  - apps/web/app/onboarding/page.tsx ($insert_id on onboarding_completed)
  - apps/web/app/api/onboarding/route.ts ($insert_id on emit)
  - apps/web/app/api/onboarding/route.test.ts (pin updated)
- Tests: 405 passing (was 395, +10 — 5 funnelInsertId + 5 runRoastSubmitted)
- Build: green, typecheck green

## Active Blockers

- None

## Next Up

- PRD-011: PostHog funnel tracking — dedup is the last identified data-integrity gap; remaining funnel work is dashboard wiring, not emission
- PRD-013: Stripe Checkout integration ($297 one-time)
- PRD-014: Onboarding wizard (5 steps) — wizard exists; deepen ICP validation

## Key Decisions This Session

- Iter 21: Funnel double-counting bug in `viewed_result` + `onboarding_completed`
  resolved with PostHog `$insert_id` dedup, keyed via `funnelInsertId(event, key)`
  helper. Format `${event}:${key}` lives in zero-deps `funnel-keys.ts` so client
  components can import without dragging posthog-node into browser bundle.
  `submitted_email` left as-is — no shared natural key between client (pre-API)
  and server (pre-agent-call) emissions; documented as intentional in funnel.ts.

## Mistakes & Learnings

- Iter 21 mistake: First placed `funnelInsertId` in `funnel.ts` which transitively
  imports `posthog-node` via `observability.ts`. Client Component bundling failed
  with `node:readline` resolution error. Lesson: any helper used from a Client
  Component must live in a module with zero Node-only deps. Extracted to
  `funnel-keys.ts` and added `./funnel-keys` subpath export. Tests in
  `funnel.test.ts` import via the `./funnel.js` re-export so the dedup-key
  format contract is pinned regardless of which entry point a caller uses.
