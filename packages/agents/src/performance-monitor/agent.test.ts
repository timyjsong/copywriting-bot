import { describe, expect, it } from "vitest";
import { computePerformance } from "./agent.js";

const CID = "00000000-0000-0000-0000-000000000001";
const CAMP = "00000000-0000-0000-0000-000000000002";

describe("computePerformance", () => {
  it("computes uplift when baseline is set", () => {
    const out = computePerformance({
      campaign_id: CAMP,
      customer_id: CID,
      baseline_reply_rate: 0.02,
      metrics_today: { sent: 100, opens: 40, replies: 4, meetings_booked: 1 },
      days_since_start: 10,
      uplift_target_pct: 10,
    });
    expect(out.current_reply_rate).toBeCloseTo(0.04, 4);
    expect(out.uplift_pct).toBeCloseTo(100, 1);
    expect(out.trigger_21_day_milestone).toBe(false);
    expect(out.trigger_free_rewrite).toBe(false);
  });

  it("flags low open rate as deliverability risk", () => {
    const out = computePerformance({
      campaign_id: CAMP,
      customer_id: CID,
      baseline_reply_rate: null,
      metrics_today: { sent: 200, opens: 4, replies: 0, meetings_booked: 0 },
      days_since_start: 5,
      uplift_target_pct: 10,
    });
    expect(out.alerts.some((a) => a.includes("Open rate"))).toBe(true);
    expect(out.alerts.some((a) => a.includes("Zero replies"))).toBe(true);
  });

  it("triggers 21-day free rewrite when uplift below target", () => {
    const out = computePerformance({
      campaign_id: CAMP,
      customer_id: CID,
      baseline_reply_rate: 0.02,
      metrics_today: { sent: 100, opens: 30, replies: 2, meetings_booked: 0 },
      days_since_start: 21,
      uplift_target_pct: 10,
    });
    expect(out.trigger_21_day_milestone).toBe(true);
    expect(out.trigger_free_rewrite).toBe(true);
    expect(out.alerts.some((a) => a.includes("21-day"))).toBe(true);
  });

  it("does NOT trigger free rewrite if uplift meets target", () => {
    const out = computePerformance({
      campaign_id: CAMP,
      customer_id: CID,
      baseline_reply_rate: 0.02,
      metrics_today: { sent: 100, opens: 30, replies: 4, meetings_booked: 1 },
      days_since_start: 22,
      uplift_target_pct: 10,
    });
    expect(out.trigger_21_day_milestone).toBe(true);
    expect(out.trigger_free_rewrite).toBe(false);
  });

  it("handles zero sends gracefully", () => {
    const out = computePerformance({
      campaign_id: CAMP,
      customer_id: CID,
      baseline_reply_rate: 0.02,
      metrics_today: { sent: 0, opens: 0, replies: 0, meetings_booked: 0 },
      days_since_start: 1,
      uplift_target_pct: 10,
    });
    expect(out.current_reply_rate).toBe(0);
    expect(out.uplift_pct).toBeCloseTo(-100, 1);
  });
});
