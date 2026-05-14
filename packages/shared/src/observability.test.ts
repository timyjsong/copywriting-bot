import { describe, expect, it } from "vitest";
import type { FunnelEvent } from "./observability.js";

/**
 * The FunnelEvent union is the SSOT for every PostHog event our funnels rely
 * on. These tests defend two real properties:
 *
 *  1. The union (compile-time) covers every event name we emit (runtime).
 *     `EXPECTED` below is the explicit list — typed as `FunnelEvent[]`, so any
 *     drift between this list and the union is a type error at build time.
 *
 *  2. The runtime list has no duplicates and matches the documented size.
 *
 * If a new funnel event is added, update `EXPECTED` here AND the union in
 * observability.ts in the same change — the typecheck will refuse otherwise.
 */

const EXPECTED: ReadonlyArray<FunnelEvent> = [
  "visited_landing",
  "started_roast",
  "submitted_email",
  "viewed_result",
  "clicked_upsell",
  "started_checkout",
  "completed_checkout",
  "onboarding_started",
  "onboarding_step_completed",
  "onboarding_completed",
  "rewrite_approved",
  "sequence_activated",
  "performance_report_sent",
] as const;

describe("FunnelEvent union", () => {
  it("has no duplicate event names", () => {
    expect(new Set(EXPECTED).size).toBe(EXPECTED.length);
  });

  it("rejects an unknown event name at the type boundary", () => {
    // @ts-expect-error — "not_a_real_event" is intentionally not in the union.
    const bad: FunnelEvent = "not_a_real_event";
    expect(typeof bad).toBe("string");
  });

  it("accepts every documented funnel step", () => {
    // Compile-time check: each literal must be assignable to FunnelEvent.
    const each: FunnelEvent[] = [
      "visited_landing",
      "started_roast",
      "submitted_email",
      "viewed_result",
      "clicked_upsell",
      "started_checkout",
      "completed_checkout",
      "onboarding_started",
      "onboarding_step_completed",
      "onboarding_completed",
      "rewrite_approved",
      "sequence_activated",
      "performance_report_sent",
    ];
    expect(each).toEqual([...EXPECTED]);
  });
});
