# Session Continuity

Updated: 2026-05-14T14:35:00Z

## Current State

- Iteration: 17
- Phase: PHASE_2_PAID_FLOW
- RARV Step: VERIFY
- Provider: claude
- Elapsed: 3h 30m

## Last Completed Task

- Iter 17: close iter-16 code-review gaps. Bulletproof captureException (then-able
  rejection guard + console.error swallow), wrap captureException itself in a
  try/catch at /api/roast + /api/onboarding catch handlers (true defense in
  depth), add tests for: Sentry async-rejection (no unhandled rejection),
  stderr-broken last-resort log, route-level total-observability failure,
  runRoastAgent ok:false, /api/roast DB insert failure, full roast response
  shape, inngest dispatch payload, `roasts` table name capture.
- Tests: 371 passing across packages/shared, packages/agents, packages/inngest,
  apps/web, apps/ops.
- Files changed: packages/shared/src/observability.ts,
  packages/shared/src/safe-capture.test.ts,
  apps/web/app/api/roast/route.ts, apps/web/app/api/roast/route.test.ts,
  apps/web/app/api/onboarding/route.ts, apps/web/app/api/onboarding/route.test.ts

## Active Blockers

- None

## Next Up

- PostHog funnel tracking (PRD-011) — wiring is in place at /api/roast +
  /api/onboarding; need to instrument the remaining funnel steps
  (visited_landing, viewed_result, clicked_upsell, started_checkout,
  completed_checkout) and verify in PostHog dashboard.
- Ship to production (PRD-012)
- Stripe Checkout integration $297 (PRD-013)

## Mistakes & Learnings

- Iter 17 / async rejection test: `mockReturnValueOnce(Promise.reject(...))`
  creates the rejected promise at test-setup time, which lets Node fire
  `unhandledRejection` before the production code's `.catch` attaches —
  test flakes with PromiseRejectionHandledWarning. Use
  `mockImplementationOnce(() => Promise.reject(...))` so the promise is
  created in the same microtask as the catch attach. Defended in
  safe-capture.test.ts "still resolves when Sentry capture returns a
  rejected promise (no unhandled rejection)".
- Iter 17 / "bulletproof at the source, double-guard at the boundary":
  observability.ts captureException now never throws (then-able catch +
  stderr swallow), AND route handlers wrap their captureException call
  in try/catch. The route-level wrap is dead code at runtime but
  enforceable contract in tests. Defense-in-depth pattern.

## Key Decisions This Session

- Inline route-level try/catch rather than extracting a `fireAndForgetFunnel`
  helper. Two call sites does not justify the abstraction, and the existing
  test mocks already target `captureServerEventSafe` directly — adding a
  helper would force mock-rewrites across both route test suites for no
  clarity gain.
