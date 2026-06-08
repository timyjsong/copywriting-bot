# Copywriting Bot

Autonomous cold-email optimization for B2B SaaS founders — a productized, self-serve service built around an **operator-gated multi-agent pipeline** and durable, resumable workflows.

> **Status:** Feature-complete MVP scaffold. The nine-agent pipeline is implemented and unit-tested (52 tests, clean strict-TypeScript typecheck across six workspaces) against mocked external services. It has **not** been deployed or run against live credentials — a working prototype, not a shipped product. See [Project status](#project-status).

## What it does

A founder pastes their cold-email sequence into a free **Roast** tool and gets an AI-scored critique with a preview rewrite. They can then pay for a full rewrite driven by a B2B-SaaS-to-SaaS playbook: brand-voice analysis, a warmup-managed send schedule, 30 days of reply-rate monitoring, and an automatic refund if the target is missed. **Every AI-generated output passes through an operator approval queue before it reaches a customer** — autonomous, but never unsupervised.

## Architecture

pnpm monorepo, TypeScript end to end:

```
apps/
  web/   Next.js 15 — marketing site, free Roast tool, Stripe checkout, onboarding, customer dashboard
  ops/   Next.js 15 — operator dashboard: approval queue (one-click approve/reject), customers, health
packages/
  agents/   9 agents over a shared Anthropic client (prompt caching, JSON + Zod validation per boundary)
  inngest/  Durable workflows: onboarding pipeline, checkout hook, daily performance pull, send, refund
  db/       Supabase client, typed schema, SQL migration
  shared/   Zod-validated env loaders, Sentry + PostHog observability, canonical agent schemas
```

### The agent pipeline

Nine agents share one Anthropic client that enforces prompt caching and structured-JSON output; each validates its result against a Zod schema before handing off, and each runs on a deliberately chosen model tier.

| Agent | Tier | Role |
|---|---|---|
| Roast | Haiku | Free tool — scores a sequence on 6 dimensions, returns a rewrite preview |
| Brand Voice | Haiku | Extracts tone, positioning, and avoid-phrases from a customer's site |
| Rewrite | Sonnet | Rewrites the full sequence to the brand-voice profile; flags new claims for review |
| Onboarder | — | Deterministic validation of the onboarding payload |
| Warmup Planner | Sonnet | Generates a ≤10-day inbox warmup schedule from domain age/history |
| Batch Personalizer | Haiku | Personalizes opener lines per prospect against an approved template |
| Performance Monitor | — | Deterministic reply-rate uplift vs. baseline; fires the refund trigger |
| Outbound | Sonnet | Writes the bot's own cold outreach, anchored on Apollo signals |
| Support | Sonnet | Triages inbound mail into 8 categories, drafts operator-gated replies |

The paid-customer flow runs as a **durable Inngest workflow with a human approval gate**:

```
Stripe checkout
  → onboarding pipeline
      load sequence → Brand Voice → Rewrite → persist (pending_approval)
      → step.waitForEvent("operator.approval", timeout 7d)   ← operator approves in the ops app
      → on approve: continue    on reject: halt + log
Daily cron (06:30 UTC)
  → pull Smartlead metrics → compute uplift → if 21-day target missed, auto-trigger a free rewrite
```

The `waitForEvent` step is the core pattern: the workflow durably suspends — up to seven days — until a human acts, then resumes exactly where it left off.

## Running locally

```bash
# Node 20+, pnpm 10+
pnpm install
cp .env.example .env.local      # fill in credentials (all default to placeholders)
pnpm dev                        # web on :3000, ops on :3001
pnpm test                       # 52 Vitest unit tests
```

Optional: local Supabase (`supabase start` + apply `packages/db/migrations/0001_init.sql`) and the Inngest dev server (`npx inngest-cli@latest dev`). Tests run with stub env vars — no real credentials needed.

## Project status

**Implemented and tested:** the free Roast tool end to end; Stripe Checkout + webhook (test mode); the onboarding pipeline with operator approval gate; the operator approval-queue UI; all 9 agents (unit-tested against a mock Anthropic client); Smartlead and Apollo HTTP clients; the deterministic performance monitor and daily cron; the full Supabase schema (10 tables); Sentry + PostHog wiring; legal and programmatic-SEO pages. 52 unit tests pass; typecheck is clean across all six workspaces.

**Stubbed / Phase 2:** brand-voice URL fetch in the onboarding step (the agent works; the caller passes mock content); customer JWT auth (dashboard is currently email-keyed); the ops health page; the Postmark result email; end-to-end Outbound integration; e2e/Playwright tests; production deployment config. Nothing has been run against live credentials.

## License

MIT — see [LICENSE](./LICENSE).
