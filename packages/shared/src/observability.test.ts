import { describe, expect, it } from "vitest";
import type { FunnelEvent } from "./observability.js";

/**
 * Compile-time contract: the FunnelEvent union must contain every event the
 * web client fires. If we add or rename a client event, this list (and the
 * type) must stay in sync — otherwise PostHog funnels break silently.
 */
describe("FunnelEvent union", () => {
  it("includes all client-fired events", () => {
    const clientEvents: FunnelEvent[] = [
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
    ];
    // The line above is the assertion: type-checking will fail at build if
    // any of these strings drift from the union. Runtime: trivial sanity.
    expect(new Set(clientEvents).size).toBe(clientEvents.length);
  });

  it("includes all server-only lifecycle events", () => {
    const serverEvents: FunnelEvent[] = [
      "rewrite_approved",
      "sequence_activated",
      "performance_report_sent",
    ];
    expect(serverEvents.length).toBe(3);
  });
});
