import { describe, expect, it } from "vitest";
import { onboardingCompletedPayload } from "./funnel-payloads.js";

/**
 * Pins the client-side `onboarding_completed` payload contract.
 *
 * The same logical event is emitted server-side from
 * `app/api/onboarding/route.ts:114-127` via `emitFunnelEventBestEffort`. Both
 * sides MUST set `$insert_id: "onboarding_completed:<customer_id>"` so PostHog
 * dedupes the dual emit. The literal here IS the contract — drift between
 * client + server is exactly what iter 20/21 hardened against, and this test
 * is the client-side pin that was previously missing (iter-21 review #2).
 *
 * Also pins the conditional-spread that is intentionally asymmetric with the
 * roast payload: when the API response is malformed and customer_id is
 * missing, the client OMITS $insert_id entirely. Inlining
 * `funnelInsertId("…", undefined)` would otherwise collapse every malformed
 * response into the `"onboarding_completed:undefined"` bucket — useless for
 * dedup and the exact iter-21 review #3 scenario.
 */

describe("onboardingCompletedPayload", () => {
  it("sets $insert_id to the canonical onboarding_completed:<customer_id> format (dedup contract with server)", () => {
    const payload = onboardingCompletedPayload("11111111-1111-1111-1111-111111111111");
    // Hard-pin the literal — match the server pin in
    // apps/web/app/api/onboarding/route.test.ts:222-225.
    expect(payload).toEqual({
      customer_id: "11111111-1111-1111-1111-111111111111",
      $insert_id: "onboarding_completed:11111111-1111-1111-1111-111111111111",
    });
  });

  it("OMITS $insert_id when customer_id is null (iter-21 review #3 — no undefined-bucket collapse)", () => {
    const payload = onboardingCompletedPayload(null);
    expect(payload).toEqual({ customer_id: null });
    // Pin: the key is absent (not present-with-undefined), so PostHog won't
    // see a literal "onboarding_completed:undefined" insert_id from a fleet
    // of malformed responses and collapse them into one bucket.
    expect("$insert_id" in payload).toBe(false);
  });

  it("OMITS $insert_id when customer_id is undefined (same defensive branch)", () => {
    const payload = onboardingCompletedPayload(undefined);
    expect(payload).toEqual({ customer_id: null });
    expect("$insert_id" in payload).toBe(false);
  });

  it("OMITS $insert_id when customer_id is an empty string (falsy — would otherwise produce the 'onboarding_completed:' bucket)", () => {
    // Boundary the iter-21 review specifically called out: a malformed 200
    // response that returned `customer_id: ""` short-circuits the conditional
    // spread (empty string is falsy) and skips the dedup key. Pinning that
    // "" routes through the defensive branch for $insert_id. Asymmetric with
    // viewedResultPayload, which DOES emit "viewed_result:" for the same
    // input. Both are intentional; both pinned.
    //
    // Note: `customer_id` itself is forwarded verbatim — `"" ?? null` is `""`,
    // not null (nullish coalescing only triggers on null/undefined). So a
    // malformed response surfaces `customer_id: ""` to PostHog rather than
    // null, which is fine because the missing $insert_id (the actual dedup
    // contract) is what matters. Pinning both halves of that asymmetry.
    const payload = onboardingCompletedPayload("");
    expect(payload.customer_id).toBe("");
    expect("$insert_id" in payload).toBe(false);
  });

  it("returns a stable shape across calls (no Date.now, no uuid leak)", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    expect(onboardingCompletedPayload(id)).toEqual(onboardingCompletedPayload(id));
  });
});

describe("client/server $insert_id symmetry — the contract this whole file exists to defend", () => {
  /**
   * The whole point of `funnelInsertId` + the dual-emission pattern is that
   * the client and server produce IDENTICAL `$insert_id` strings so PostHog
   * dedupes them. These tests inline the server format (re-deriving it from
   * the same helper) to make drift catastrophically loud — a future refactor
   * that swaps one side's format must fail both client + server tests, not
   * silently keep one side green.
   */

  it("matches the server-emitted $insert_id format byte-for-byte for the happy path", async () => {
    const { funnelInsertId } = await import("@copywriting-bot/shared/funnel-keys");
    const id = "33333333-3333-3333-3333-333333333333";
    const clientPayload = onboardingCompletedPayload(id);
    // Server emit at app/api/onboarding/route.ts:124 uses exactly this call.
    const serverInsertId = funnelInsertId("onboarding_completed", id);
    expect(clientPayload.$insert_id).toBe(serverInsertId);
  });
});
