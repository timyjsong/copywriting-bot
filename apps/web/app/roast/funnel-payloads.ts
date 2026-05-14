import type { RoastResultT } from "@copywriting-bot/shared/schemas";
import { funnelInsertId } from "@copywriting-bot/shared/funnel-keys";

/**
 * Pure builders for the `trackClient` payloads emitted from `roast/page.tsx`.
 *
 * Extracted so the `$insert_id` dedup contract — the literal string that must
 * match the server-side emit in `packages/inngest/src/functions/roast.ts` — is
 * unit-testable without a React/jsdom harness. The page imports these and
 * passes the return value straight to `trackClient`; a regression that drops
 * the key, drifts the format, or keys on something non-stable would fail the
 * sibling test, not silently double-count `viewed_result` in PostHog.
 *
 * Why a function and not an inline literal: client + server MUST share the
 * same `$insert_id`. Centralising the format kills the whole class of bug.
 * See `packages/shared/src/funnel-keys.ts` for the format itself.
 */
export function viewedResultPayload(
  result: RoastResultT,
  roastId: string,
): {
  roast_id: string;
  overall_score: number;
  is_real_cold_email: boolean;
  $insert_id: string;
} {
  return {
    roast_id: roastId,
    overall_score: result.overall_score,
    is_real_cold_email: result.is_real_cold_email,
    $insert_id: funnelInsertId("viewed_result", roastId),
  };
}

/**
 * Payload for `clicked_upsell` fired from the "Start checkout →" CTA on the
 * roast result view. This is THE top-of-funnel conversion event from free →
 * paid; an inflated count here directly distorts the `viewed_result →
 * clicked_upsell` conversion ratio.
 *
 * Dedup-keyed on `roast_id` so that a user repeatedly clicking the button
 * (double-click, navigate-back-and-click, etc.) within PostHog's 24h dedup
 * window collapses to a single conversion intent against this roast.
 *
 * Conditional-spread philosophy mirrors `onboardingCompletedPayload` rather
 * than `viewedResultPayload`'s deterministic-empty-bucket asymmetry. The
 * `roastId` prop into `RoastResultView` is typed `string | null` and the
 * empty-string default at line 217 of `roast/page.tsx` means the click can
 * fire with no real entity to key on; collapsing every nullish-id click into
 * `"clicked_upsell:"` would silently bucket every cross-user click in that
 * degraded state to one event. Skipping the key in that case lets PostHog's
 * default per-event semantics take over instead.
 *
 * NOTE: there is no server-side emission of `clicked_upsell` (verified by
 * grep against packages/inngest/), so the asymmetric/no-key fallback here
 * cannot drift a sibling server pin.
 */
export function clickedUpsellRoastResultPayload(
  roastId: string | null,
  overallScore: number,
): {
  surface: "roast_result";
  roast_id: string | null;
  overall_score: number;
  $insert_id?: string;
} {
  return {
    surface: "roast_result",
    roast_id: roastId,
    overall_score: overallScore,
    ...(roastId ? { $insert_id: funnelInsertId("clicked_upsell", roastId) } : {}),
  };
}
