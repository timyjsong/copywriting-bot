# Session Continuity

Updated: 2026-05-14T18:25:00Z

## Current State

- Iteration: 15
- Phase: PHASE_2_PAID_FLOW
- RARV Step: REFLECT
- Provider: claude
- Elapsed: 3h 18m

## Last Completed Task

- Iter 15: harden HTTP funnel emission. Added `captureServerEventSafe` so a
  PostHog 5xx never fails a user-facing request. Migrated /api/roast and
  /api/onboarding to the safe variant. Inngest steps keep the unsafe variant
  so `step.run` retries still fire on transient PostHog failure.
- Files changed: packages/shared/src/observability.ts,
  packages/shared/src/safe-capture.test.ts (new),
  apps/web/app/api/roast/route.ts,
  apps/web/app/api/onboarding/route.ts,
  apps/web/app/api/onboarding/route.test.ts
- Tests: 357 passed (was 351; +5 in shared, +1 in web). Typecheck green.

## Active Blockers

- None

## Next Up

- PostHog funnel tracking (broader: client-side funnel ID stitching)
- Ship landing page + roast tool to production
- Stripe Checkout integration (already partially scaffolded; verify webhook flow)

## Key Decisions This Session

- HTTP routes use `captureServerEventSafe` (swallow + Sentry); Inngest steps
  use `captureServerEvent` (rethrow so step retries fire). One module, two
  contracts, documented in the function JSDoc.

## Mistakes & Learnings

- (iter 15) A funnel event sitting *before* the agent call in an HTTP route is
  a critical-path dependency on a non-critical service. If PostHog 5xxs, the
  user gets a 500 even though we could have completed the request. Lesson:
  observability calls in HTTP routes must be non-fatal; observability calls
  in durable steps should still surface errors to drive retries.
