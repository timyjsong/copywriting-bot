# Session Continuity

Updated: 2026-05-14T14:53:00Z

## Current State

- Iteration: 19
- Phase: PHASE_2_PAID_FLOW
- RARV Step: REFLECT
- Provider: claude

## Last Completed Task

- Iter 19: close iter-18 code-review gaps on emitFunnelEventBestEffort
  - Renamed misleading test ("still returns 200…" that actually asserted rejects)
  - Added symmetric onboarding route pin for primitive-throw
  - Split `emitFunnelEventBestEffort` into `funnel.ts` so the outer `ctx.phase` catch is testable (same-module calls bypass vi.mock)
  - Added new `funnel.test.ts` (7 tests) covering happy path, both phase tags on outer-catch, captureException-itself-throws, empty distinctId, empty props, circular ref
  - Symmetry assertion: emit fired before inngest in roast-inngest-failure test
  - Negative-space pin: phase tag NOT applied on inner-wrapper escape
  - Replaced two `try/finally console.error` mutations with `vi.spyOn` auto-restore
  - JSDoc on funnel.ts documents the (intentional) caller-chosen ordering convention
- Vitest: 383 passing (was 375; +8 new)
- Typecheck: clean across all 6 workspaces

## Active Blockers

- None
- Pre-existing: `pnpm lint` fails because Next.js's interactive ESLint setup prompt blocks CI in apps/{web,ops}; not introduced by iter 19.

## Next Up

- PostHog funnel tracking polish — iter 19 closes review gaps; next iter can return to PRD scope (prd-011/012/013: Stripe Checkout, ship-to-prod, onboarding wizard).

## Key Decisions This Session

- **Split `emitFunnelEventBestEffort` into its own module (`packages/shared/src/funnel.ts`).** Reason: a same-module call to `captureServerEventSafe` could not be intercepted by `vi.mock`, leaving the outer `ctx.phase` catch (and the parameter itself) as unverifiable scaffolding. Re-exported from `observability.ts` so caller imports remain stable.
