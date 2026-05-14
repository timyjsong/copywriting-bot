# Session Continuity

Updated: 2026-05-14T15:42:00Z

## Current State

- Iteration: 1
- Phase: PHASE_0_FOUNDATIONS → PHASE_1_FREE_TOOL (in progress)
- Provider: claude
- Elapsed: ~37m

## Last Completed Task

- Full monorepo scaffold (Phase 0 foundations) + first cut of Phase 1 free
  Roast tool + Phase 2 paid flow + Phase 3 send-infra + Phase 4 outbound +
  Phase 6 support agents.

## Active Blockers

- None physical. Project compiles, typechecks, and 26 unit tests pass.
- Pre-launch checklist (Supabase project, Stripe account, Vercel/Inngest
  account, Smartlead, Postmark, Apollo, Anthropic key, LLC formation) is
  operator-side and surfaced in PRD §11.

## Next Up (planned for Iteration 2+)

- Wire actual brand-voice scraper fetch (currently expects pre-fetched content).
- Playwright e2e covering Roast page → API → result display.
- Operator approval inline editor (edit_and_approve flow needs UI).
- Customer dashboard live-data wiring via Supabase RLS + session JWT.
- Phase 5: programmatic-SEO page template + sitemap generator.
- Real Postmark transactional email send-after-roast (currently track-only).
- Sentry init files for each Next app.
- Performance baseline capture from initial sequence so uplift_pct isn't always null.

## Key Decisions This Session

- Stack: PRD §5.5 defaults (Next.js 15 App Router, Supabase, Inngest, Anthropic,
  Smartlead, Postmark, Stripe, Sentry, PostHog). No deviations.
- Monorepo: pnpm workspaces with `apps/{web,ops}` and `packages/{agents,db,inngest,shared}`.
- Database type: NOT passed as <Database> generic to SupabaseClient. supabase-js
  v2.105's typed-client requires the auto-generated `Database` type shape,
  which is a moving target. We validate inputs/outputs with zod schemas in
  packages/shared instead. Schema mirror lives in packages/db/src/types.ts for
  documentation. Phase 2: run `supabase gen types typescript` and swap in.
- Anthropic prompt caching: `cachedSystemBlock()` helper used by every agent
  (PRD §5.4 mandate). All agents return JSON; tolerant extractor handles
  fenced/bare/prose-wrapped output and validates via zod.
- Approval gate primitive: Inngest `step.waitForEvent("operator.approval", { if: "async.data.id == \"...\"" })`.
  Operator dashboard POST emits the event.
- Two Next apps share packages via workspace deps and `transpilePackages`.
  apps/web :3000, apps/ops :3001.
- Stripe API version pinned to `2025-02-24.acacia` (matches Stripe SDK 17.x).

## Checklist progress (.loki/checklist/checklist.json)

- phase-0-foundations: ALL items implemented (monorepo, env, schema migration,
  Inngest functions, Stripe webhook, Anthropic client with caching, observability,
  CI workflow).
- phase-1-free-tool: landing page, /roast page, /api/roast endpoint, email capture,
  shareable OG image route, PostHog server-side funnel events.
- phase-2-paid-flow: /api/checkout, onboarding wizard, customer dashboard skeleton,
  Rewrite Agent, operator dashboard + approval queue, approval flow via Inngest.
- phase-3-send-infra: Smartlead HTTP client, Send Infra Agent (warmup planner +
  batch personaliser), DNS verification.
- phase-4-outbound: Apollo client + Outbound Agent.
- phase-6-polish: Support Agent. Refund flow + 21-day milestone trigger present
  (in Performance Monitor + Stripe webhook stub for charge.refunded).

Remaining checklist items (real wiring vs. scaffold):
- p1-og-badge: implemented as route, not yet integration-tested
- p2-customer-dashboard: skeleton only
- p3-performance-monitor: agent done; Postmark report email not yet hooked
- p5-seo-pages: NOT started
- p6-refund: stub only (charge.refunded TODO comment in Stripe webhook)

## Mistakes & Learnings

1. **Supabase-js v2.105 type generic is fragile.** First attempt passed
   `<Database>` to `createClient()` with a hand-rolled `Database` interface
   covering only Tables. supabase-js v2.105 expects auto-generated structure
   including `Views: Record<string, GenericView>`, `Functions: Record<string, GenericFunction>`,
   plus `__InternalSupabase` machinery. Hand-rolling this is brittle and
   downstream call sites silently get `never`. **Lesson:** for MVP, run
   `supabase gen types typescript` once you have a live project, or leave
   the client untyped and rely on zod at boundaries. Don't attempt to
   hand-mirror Database types.

2. **vitest exits 1 with no test files by default.** Added `--passWithNoTests`
   to the test scripts in packages with no tests yet (db, inngest). **Lesson:**
   always add `--passWithNoTests` to package test scripts in a monorepo or
   you'll fail CI on infrastructure-only packages.

3. **Anthropic SDK v0.32 doesn't expose `cache_read_input_tokens` on Usage.**
   Newer SDKs do. Wrapped access via cast to a structural type so the field
   is optional. **Lesson:** when reading optional usage fields off third-party
   SDK responses, never assume version-specific properties without an `in` check
   or a cast.

4. **Stripe SDK 17.x pins to a specific API version.** Used `2025-02-24.acacia`
   (the SDK's expected version). **Lesson:** Stripe's `apiVersion` literal is
   type-checked against the SDK version — don't paste-in older versions.

5. **Inngest `waitForEvent` `if` syntax uses `async.data.X`, not `event.data.X`.**
   The matching expression refers to the *incoming* event as `async`, not `event`.
   **Lesson:** Inngest's docs on waitForEvent show `async.data.X == "..."`
   form; using `event.data.X` is the pattern for the function's *trigger*
   event, not for waitForEvent matchers.

## Verification (this iteration)

- `pnpm install`: 785 packages installed, 0 errors.
- `pnpm -r typecheck`: PASS across all 6 workspaces.
- `pnpm -r test`: 26/26 tests pass (shared:5, agents:17, web:4) + 2 packages
  with no tests (db, inngest, ops) — all PASS.
- Manual: each app's package.json exposes dev/build/start scripts; CI workflow
  at `.github/workflows/ci.yml` runs typecheck → lint → test → build.
- Git: this iteration committed as a single atomic checkpoint.
