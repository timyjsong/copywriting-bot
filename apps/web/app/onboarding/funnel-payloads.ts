import { funnelInsertId } from "@copywriting-bot/shared/funnel-keys";

/**
 * Pure builder for the `trackClient("onboarding_completed", …)` payload
 * emitted from `onboarding/page.tsx`.
 *
 * Extracted so the `$insert_id` dedup contract — the literal string that must
 * match the server-side emit in `app/api/onboarding/route.ts` — is unit-
 * testable without a React/jsdom harness.
 *
 * Defensive asymmetry vs `viewedResultPayload`: the `viewed_result` emit always
 * has a `roast_id` (the API returns it before the client emits), but
 * `onboarding_completed` runs even when the API response is malformed and
 * `customer_id` is missing. Inlining `funnelInsertId("…", undefined)` would
 * produce `"onboarding_completed:undefined"` — deterministic but useless for
 * dedup (every malformed response collapses to the same bucket). The
 * conditional-spread skips the key in that case and lets PostHog rely on
 * server-side dedup alone.
 */
export function onboardingCompletedPayload(
  customerId: string | null | undefined,
): {
  customer_id: string | null;
  $insert_id?: string;
} {
  return {
    customer_id: customerId ?? null,
    ...(customerId
      ? { $insert_id: funnelInsertId("onboarding_completed", customerId) }
      : {}),
  };
}
