# Session Continuity

Updated: 2026-05-14T17:00:00Z

## Current State

- Iteration: 6
- Phase: PHASE_2_PAID_FLOW
- RARV Step: VERIFY
- Provider: claude
- Elapsed: 1h 55m

## Last Completed Task

- Iter 6: wire 3 unfired PostHog funnel events (rewrite_approved, sequence_activated, performance_report_sent)
- Files changed: packages/inngest/src/functions/{onboarding,sendBatch,performance}.ts + new test file
- Tests added: 4 (funnel-events.test.ts) — 247 total now passing
- Typecheck: green. Build: green.

## Active Blockers

- None

## Next Up

- PostHog funnel tracking — fully wired across server-side gate transitions now
- **Ship to production. This goes live before anything else.**
- Stripe Checkout integration ($297 one-time) — already integrated, may need DNS/deploy work

## Key Decisions This Session

- Iter 6 chose to close funnel gaps (3 declared FunnelEvent variants were never emitted) over starting Phase 3 send-infra work — closes the loop on PRD §3 PostHog funnel coverage.
- sequence_activated fires only on the FIRST approved send batch (deduped by querying prior approved batches), not every batch — semantically "the sequence went live."
- performance_report_sent fires once per campaign per daily snapshot — semantically "report data is available in the dashboard."
- All funnel emissions wrapped in step.run for Inngest durability; idempotent at the step boundary.

## Mistakes & Learnings

- Iter 3 finding: FunnelEvent union was duplicated between shared/observability.ts and apps/web/posthog-client.ts. Fixed in iter 4 by re-exporting the type. Lesson: SSOT for cross-package types belongs in @copywriting-bot/shared; client code imports, never redeclares.
- Iter 3 finding: ApprovalSummary was a god-switch in apps/ops/app/approvals/page.tsx. Fixed in iter 4 by extracting renderers.tsx with a per-type registry. Lesson: open/closed in approval surfaces — add a new approval type by extending the renderer map, not editing the page.
- Iter 5 finding: many newly-added routes shipped with zero tests. Iter 5 added 131 unit tests across schemas, env, helpers, scoring, dashboard. Lesson: every new route/helper gets a sibling .test.ts in the same iteration that creates it.
