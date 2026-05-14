# Copywriting Bot

Autonomous cold-email optimization service for B2B SaaS founders. See
[`.loki/bmad-prd-normalized.md`](./.loki/bmad-prd-normalized.md) for the full PRD.

## Repository layout

```
apps/
  web/      Next.js 15 — public marketing site, free Roast tool, paid customer dashboard
  ops/      Next.js 15 — operator dashboard (approval queues, P&L, alerts)
packages/
  agents/   Anthropic-backed agents (Roast, Rewrite, Brand Voice, Send Infra, ...)
  db/       Supabase schema, migrations, generated types, repository helpers
  inngest/  Durable workflow functions with operator approval gates
  shared/   Env validation, observability, zod schemas, cross-package utilities
```

## Local development

Prerequisites: Node 20+, pnpm 10+, Supabase CLI (optional, for local DB).

```bash
pnpm install
cp .env.example .env.local   # populate with real credentials
pnpm dev                     # runs apps/web on :3000, apps/ops on :3001
```

## Stack (per PRD §5.5)

- TypeScript everywhere
- Next.js 15 (App Router) + RSC, Tailwind + shadcn/ui
- Supabase (Postgres + Auth + Storage, pgvector enabled)
- Inngest (durable functions with `step.waitForEvent` approval gates)
- Anthropic SDK with prompt caching on system prompts
- Stripe Checkout (test mode in MVP)
- Smartlead (customer send infra), Postmark (transactional), Apollo (prospect enrichment)
- Sentry + PostHog + Inngest run viewer

## Operating principles

1. Niche depth — B2B SaaS-to-SaaS only.
2. Optimization > generation — we never rewrite from a blank brief.
3. Productized self-serve only — no discovery calls.
4. Bot eats its own dog food.
5. Free Roast tool is the front door.
6. Approval gates default-ON for the first 50 customers.
7. English-language, US/UK/CA/AU only.
