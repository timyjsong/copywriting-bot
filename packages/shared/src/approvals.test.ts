import { describe, expect, it } from "vitest";
import {
  formatDuration,
  groupCounts,
  normalizeApprovalPayload,
  slaOverdue,
  timeAgo,
  timeUntil,
} from "./approvals.js";

const FIXED_NOW = new Date("2026-05-14T12:00:00.000Z").getTime();

describe("formatDuration", () => {
  it("returns 'just now' for sub-minute durations", () => {
    expect(formatDuration(0)).toBe("just now");
    expect(formatDuration(59_999)).toBe("just now");
  });

  it("returns 'just now' for negative and non-finite inputs", () => {
    expect(formatDuration(-1)).toBe("just now");
    expect(formatDuration(-60_000)).toBe("just now");
    expect(formatDuration(Number.NaN)).toBe("just now");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("just now");
  });

  it("renders minutes on the [1m, 60m) boundary", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(59 * 60_000)).toBe("59m");
  });

  it("renders hours on the [1h, 24h) boundary", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(23 * 60 * 60_000)).toBe("23h");
  });

  it("renders days at and beyond 24h", () => {
    expect(formatDuration(24 * 60 * 60_000)).toBe("1d");
    expect(formatDuration(72 * 60 * 60_000)).toBe("3d");
  });
});

describe("timeAgo", () => {
  it("appends 'ago' to past timestamps", () => {
    const tenMinAgo = new Date(FIXED_NOW - 10 * 60_000).toISOString();
    expect(timeAgo(tenMinAgo, FIXED_NOW)).toBe("10m ago");
  });

  it("collapses future timestamps (clock skew) to 'just now'", () => {
    const future = new Date(FIXED_NOW + 5 * 60_000).toISOString();
    expect(timeAgo(future, FIXED_NOW)).toBe("just now");
  });

  it("returns 'just now' for an unparseable input", () => {
    expect(timeAgo("not-a-date", FIXED_NOW)).toBe("just now");
  });
});

describe("timeUntil", () => {
  it("returns absolute formatted duration regardless of sign", () => {
    const future = new Date(FIXED_NOW + 2 * 60 * 60_000).toISOString();
    const past = new Date(FIXED_NOW - 2 * 60 * 60_000).toISOString();
    expect(timeUntil(future, FIXED_NOW)).toBe("2h");
    expect(timeUntil(past, FIXED_NOW)).toBe("2h");
  });
});

describe("slaOverdue", () => {
  it("is true when the SLA timestamp is in the past", () => {
    const past = new Date(FIXED_NOW - 1).toISOString();
    expect(slaOverdue(past, FIXED_NOW)).toBe(true);
  });

  it("is false when the SLA timestamp is in the future", () => {
    const future = new Date(FIXED_NOW + 60_000).toISOString();
    expect(slaOverdue(future, FIXED_NOW)).toBe(false);
  });

  it("is false for unparseable input", () => {
    expect(slaOverdue("garbage", FIXED_NOW)).toBe(false);
  });
});

describe("groupCounts", () => {
  it("counts items grouped by type", () => {
    expect(
      groupCounts([
        { type: "rewrite" },
        { type: "rewrite" },
        { type: "send_batch" },
      ]),
    ).toEqual({ rewrite: 2, send_batch: 1 });
  });

  it("returns an empty record for an empty list", () => {
    expect(groupCounts([])).toEqual({});
  });
});

describe("normalizeApprovalPayload", () => {
  it("rewrite: extracts playbook, band, email count, and a preview", () => {
    const out = normalizeApprovalPayload("rewrite", {
      playbook_used: "saas-to-saas-v2",
      expected_reply_rate_band: "8-12%",
      emails: [
        { step: 1, subject: "Hello", body: "Hey there, this is the body" },
        { step: 2, subject: "Bump", body: "Quick bump in case you missed it" },
        { step: 3, subject: "Last", body: "Last note" },
      ],
    });
    expect(out).toMatchObject({
      kind: "rewrite",
      playbook: "saas-to-saas-v2",
      band: "8-12%",
      emailCount: 3,
      hiddenCount: 1,
    });
    if (out.kind !== "rewrite") throw new Error("type narrow failed");
    expect(out.preview).toHaveLength(2);
    expect(out.preview[0]).toEqual({
      step: "1",
      subject: "Hello",
      bodySnippet: "Hey there, this is the body",
    });
  });

  it("rewrite: malformed payload (non-array emails, missing fields) falls back to safe defaults", () => {
    const out = normalizeApprovalPayload("rewrite", { emails: "not an array" });
    expect(out).toEqual({
      kind: "rewrite",
      playbook: "—",
      band: "—",
      emailCount: 0,
      preview: [],
      hiddenCount: 0,
    });
  });

  it("rewrite: truncates body snippet to 180 chars", () => {
    const longBody = "x".repeat(500);
    const out = normalizeApprovalPayload("rewrite", {
      emails: [{ step: 1, subject: "s", body: longBody }],
    });
    if (out.kind !== "rewrite") throw new Error("type narrow failed");
    expect(out.preview[0]?.bodySnippet.length).toBe(180);
  });

  it("send_batch: coerces prospect_count and stringifies campaign_id; falls back when missing", () => {
    expect(normalizeApprovalPayload("send_batch", { prospect_count: 25, campaign_id: "cmp_1" })).toEqual({
      kind: "send_batch",
      prospectCount: 25,
      campaignId: "cmp_1",
    });
    expect(normalizeApprovalPayload("send_batch", {})).toEqual({
      kind: "send_batch",
      prospectCount: 0,
      campaignId: "—",
    });
    // Numeric strings get coerced (real Inngest payloads sometimes ship as strings).
    expect(normalizeApprovalPayload("send_batch", { prospect_count: "42" })).toMatchObject({
      prospectCount: 42,
    });
  });

  it("refund: converts cents → dollar string, even when amount is non-numeric or missing", () => {
    expect(normalizeApprovalPayload("refund", { amount: 29700, reason: "didn't work" })).toEqual({
      kind: "refund",
      amountUsd: "297.00",
      reason: "didn't work",
    });
    expect(normalizeApprovalPayload("refund", { amount: "not-a-number" })).toMatchObject({
      amountUsd: "0.00",
      reason: "—",
    });
    expect(normalizeApprovalPayload("refund", null)).toMatchObject({
      amountUsd: "0.00",
    });
  });

  it("outbound_email + support_reply: stringify fields, fall back to em-dash", () => {
    expect(normalizeApprovalPayload("outbound_email", { subject: "hi", to: "u@x.com" })).toEqual({
      kind: "outbound_email",
      subject: "hi",
      to: "u@x.com",
    });
    expect(normalizeApprovalPayload("outbound_email", {})).toEqual({
      kind: "outbound_email",
      subject: "—",
      to: "—",
    });
    expect(normalizeApprovalPayload("support_reply", { thread_id: "t_1" })).toEqual({
      kind: "support_reply",
      threadId: "t_1",
    });
    expect(normalizeApprovalPayload("support_reply", { thread_id: null })).toEqual({
      kind: "support_reply",
      threadId: "—",
    });
  });

  it("unknown approval type returns the unknown variant tagged with the original type", () => {
    expect(normalizeApprovalPayload("not_a_known_type", { foo: "bar" })).toEqual({
      kind: "unknown",
      type: "not_a_known_type",
    });
  });

  it("non-object payloads (array, null, primitive) normalize cleanly", () => {
    expect(normalizeApprovalPayload("rewrite", null).kind).toBe("rewrite");
    expect(normalizeApprovalPayload("rewrite", ["arr"]).kind).toBe("rewrite");
    expect(normalizeApprovalPayload("rewrite", "string").kind).toBe("rewrite");
  });
});
