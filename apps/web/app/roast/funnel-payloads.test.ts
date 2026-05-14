import { describe, expect, it } from "vitest";
import type { RoastResultT } from "@copywriting-bot/shared/schemas";
import { clickedUpsellRoastResultPayload, viewedResultPayload } from "./funnel-payloads.js";

/**
 * Pins the client-side `viewed_result` payload contract.
 *
 * The same logical event is emitted server-side from `runRoastSubmitted`
 * (packages/inngest/src/functions/roast.ts). Both sides MUST set
 * `$insert_id: "viewed_result:<roast_id>"` so PostHog dedupes the dual emit.
 * A typo on either side silently double-counts every successful roast and
 * inflates the `submitted_email → viewed_result` funnel.
 *
 * The literals here ARE the contract — drift between client + server is the
 * exact bug iter 20/21 hardened against, and this test is the client-side
 * pin that was previously missing (iter-21 review finding #1).
 */

function makeResult(overrides: Partial<RoastResultT> = {}): RoastResultT {
  return {
    overall_score: 72,
    is_real_cold_email: true,
    per_dimension: [
      { dimension: "specificity", score: 7, rationale: "ok" },
      { dimension: "personalization", score: 6, rationale: "ok" },
      { dimension: "structure", score: 8, rationale: "ok" },
      { dimension: "value_proposition", score: 7, rationale: "ok" },
      { dimension: "call_to_action", score: 6, rationale: "ok" },
      { dimension: "tone_and_voice", score: 7, rationale: "ok" },
    ],
    rewrite_preview: null,
    refusal_reason: null,
    ...overrides,
  } as RoastResultT;
}

describe("viewedResultPayload", () => {
  it("sets $insert_id to the canonical viewed_result:<roast_id> format (dedup contract with server)", () => {
    const payload = viewedResultPayload(makeResult({ overall_score: 88 }), "roast-abc");
    // Hard-pin the literal so a regression that drops the prefix, drifts to a
    // colon-free format, or keys on Date.now() fails loud. Match the server
    // pin in packages/inngest/src/functions/roast.test.ts:99.
    expect(payload.$insert_id).toBe("viewed_result:roast-abc");
  });

  it("forwards roast_id, overall_score, is_real_cold_email verbatim", () => {
    const result = makeResult({ overall_score: 41, is_real_cold_email: false });
    expect(viewedResultPayload(result, "roast-xyz")).toEqual({
      roast_id: "roast-xyz",
      overall_score: 41,
      is_real_cold_email: false,
      $insert_id: "viewed_result:roast-xyz",
    });
  });

  it("does NOT defensively bail when roast_id is empty — emits a deterministic-but-debuggable bucket", () => {
    // Iter-21 high-severity finding: an empty roast_id would produce
    // `$insert_id: "viewed_result:"`. This is intentional asymmetry vs
    // onboardingCompletedPayload, which conditional-spreads instead. The
    // roast API always returns a non-empty roast_id (the body is only set
    // after a successful POST that returns one) — an empty value here means
    // a contract violation upstream, and a single deterministic bucket in
    // PostHog is the lesser evil vs a random-uuid bucket per call. Pinning
    // both shape AND philosophy so a future "let's normalize this" PR can't
    // silently change either side.
    const payload = viewedResultPayload(makeResult(), "");
    expect(payload.$insert_id).toBe("viewed_result:");
    expect(payload.roast_id).toBe("");
  });

  it("returns a stable shape across calls (no Date.now, no uuid leak)", () => {
    const r = makeResult();
    expect(viewedResultPayload(r, "roast-1")).toEqual(viewedResultPayload(r, "roast-1"));
  });
});

describe("clickedUpsellRoastResultPayload", () => {
  it("sets $insert_id to the canonical clicked_upsell:<roast_id> format", () => {
    // The pin: regression that drifts the prefix, drops the colon, or keys
    // on Date.now() would silently double-count the top-of-paid-funnel
    // conversion event. Hard-pin the literal so the test fails loud.
    const payload = clickedUpsellRoastResultPayload("roast-abc", 72);
    expect(payload.$insert_id).toBe("clicked_upsell:roast-abc");
  });

  it("forwards surface, roast_id, overall_score verbatim", () => {
    expect(clickedUpsellRoastResultPayload("roast-xyz", 41)).toEqual({
      surface: "roast_result",
      roast_id: "roast-xyz",
      overall_score: 41,
      $insert_id: "clicked_upsell:roast-xyz",
    });
  });

  it("omits $insert_id entirely when roast_id is null (asymmetry vs viewedResultPayload, mirrors onboardingCompletedPayload)", () => {
    // The page renders `RoastResultView` with `roastId: string | null` and a
    // `?? ""` fallback at the href level. If the click fires with no real
    // entity to key on, deterministic-bucketing every nullish click into
    // `"clicked_upsell:"` would collapse every degraded-state click across
    // every user/session into ONE conversion event. Worse than just letting
    // PostHog count them. Skip the key in that case.
    const payload = clickedUpsellRoastResultPayload(null, 50);
    expect(payload).toEqual({
      surface: "roast_result",
      roast_id: null,
      overall_score: 50,
    });
    expect(payload.$insert_id).toBeUndefined();
    expect("$insert_id" in payload).toBe(false);
  });

  it("omits $insert_id when roast_id is empty string (same degraded-state philosophy as null)", () => {
    // Empty string is falsy under the conditional-spread guard — the
    // `roastId ?? ""` default at the href fallback is the most likely path
    // to an empty value reaching the click handler. Treat it identically to
    // null rather than collapsing to `"clicked_upsell:"`.
    const payload = clickedUpsellRoastResultPayload("", 50);
    expect(payload.$insert_id).toBeUndefined();
    expect("$insert_id" in payload).toBe(false);
  });

  it("returns a stable shape across calls (no Date.now, no uuid leak)", () => {
    expect(clickedUpsellRoastResultPayload("roast-1", 60)).toEqual(
      clickedUpsellRoastResultPayload("roast-1", 60),
    );
  });

  it("different roast_ids produce different insert_ids (no silent collision)", () => {
    // Guard against a regression that hardcodes the suffix or keys on
    // overall_score instead of roast_id (two users with the same score
    // would silently dedup to one event).
    const a = clickedUpsellRoastResultPayload("roast-a", 60);
    const b = clickedUpsellRoastResultPayload("roast-b", 60);
    expect(a.$insert_id).not.toBe(b.$insert_id);
  });

  it("cross-event isolation: same roast_id produces different keys for viewed_result vs clicked_upsell", () => {
    // The `${event}:` prefix in funnelInsertId exists exactly to namespace
    // events that share an underlying entity ID. Lock the guarantee so a
    // refactor that drops the prefix can't silently merge `viewed_result`
    // and `clicked_upsell` counts for the same roast.
    const viewed = viewedResultPayload(makeResult(), "roast-shared");
    const upsell = clickedUpsellRoastResultPayload("roast-shared", 72);
    expect(viewed.$insert_id).not.toBe(upsell.$insert_id);
  });
});
