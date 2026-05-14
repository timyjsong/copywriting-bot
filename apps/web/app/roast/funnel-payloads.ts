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
