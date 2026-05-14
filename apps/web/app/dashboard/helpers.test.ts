import { describe, expect, it } from "vitest";
import {
  campaignTone,
  performanceTone,
  renderCampaignBody,
  renderPerformanceBody,
  renderSequenceBody,
  sequenceTone,
} from "./helpers";

describe("renderSequenceBody", () => {
  it("returns pending copy when sequence is null", () => {
    expect(renderSequenceBody(null)).toMatch(/finish onboarding/i);
  });

  it("renders generating message for draft", () => {
    expect(
      renderSequenceBody({
        id: "s1",
        version: 1,
        status: "draft",
        created_at: "2026-05-01T00:00:00Z",
        approved_at: null,
      }),
    ).toMatch(/Rewrite Agent is generating/i);
  });

  it("renders pending_approval message", () => {
    expect(
      renderSequenceBody({
        id: "s1",
        version: 1,
        status: "pending_approval",
        created_at: "2026-05-01T00:00:00Z",
        approved_at: null,
      }),
    ).toMatch(/awaiting operator approval/i);
  });

  it("includes the approved date when status=approved with approved_at", () => {
    const body = renderSequenceBody({
      id: "s1",
      version: 1,
      status: "approved",
      created_at: "2026-05-01T00:00:00Z",
      approved_at: "2026-05-10T00:00:00Z",
    });
    expect(body).toMatch(/Rewrite approved on/);
    // Date.toLocaleDateString output is locale-dependent; just ensure it's not the em-dash fallback
    expect(body).not.toMatch(/—\.$/);
  });

  it("falls back to em-dash when approved without approved_at", () => {
    const body = renderSequenceBody({
      id: "s1",
      version: 1,
      status: "approved",
      created_at: "2026-05-01T00:00:00Z",
      approved_at: null,
    });
    expect(body).toMatch(/—\.$/);
  });

  it("active → 'Live — being sent'", () => {
    expect(
      renderSequenceBody({
        id: "s1",
        version: 1,
        status: "active",
        created_at: "2026-05-01T00:00:00Z",
        approved_at: "2026-05-10T00:00:00Z",
      }),
    ).toMatch(/Live/);
  });

  it("rejected → 'regenerating'", () => {
    expect(
      renderSequenceBody({
        id: "s1",
        version: 1,
        status: "rejected",
        created_at: "2026-05-01T00:00:00Z",
        approved_at: null,
      }),
    ).toMatch(/regenerating/i);
  });

  it("unknown status echoes the status value", () => {
    expect(
      renderSequenceBody({
        id: "s1",
        version: 1,
        status: "weird_state",
        created_at: "2026-05-01T00:00:00Z",
        approved_at: null,
      }),
    ).toBe("Status: weird_state");
  });
});

describe("sequenceTone", () => {
  it("undefined → neutral", () => {
    expect(sequenceTone(undefined)).toBe("neutral");
  });

  it("approved + active → good", () => {
    expect(sequenceTone("approved")).toBe("good");
    expect(sequenceTone("active")).toBe("good");
  });

  it("rejected → bad", () => {
    expect(sequenceTone("rejected")).toBe("bad");
  });

  it("any other status → pending", () => {
    expect(sequenceTone("draft")).toBe("pending");
    expect(sequenceTone("pending_approval")).toBe("pending");
    expect(sequenceTone("unknown")).toBe("pending");
  });
});

describe("renderCampaignBody", () => {
  it("returns awaiting-approval message when campaign is null", () => {
    expect(renderCampaignBody(null)).toMatch(/Awaiting rewrite approval/);
  });

  it("warmup status renders progress + cap", () => {
    expect(
      renderCampaignBody({
        id: "c1",
        status: "warmup",
        warmup_status: "day_3_of_10",
        daily_cap: 40,
        started_at: null,
      }),
    ).toMatch(/Warmup in progress \(day_3_of_10\)\. Daily cap: 40\./);
  });

  it("warmup status with null warmup_status falls back to 'scheduled'", () => {
    expect(
      renderCampaignBody({
        id: "c1",
        status: "warmup",
        warmup_status: null,
        daily_cap: 10,
        started_at: null,
      }),
    ).toMatch(/scheduled/);
  });

  it("sending → Live with daily cap + started date", () => {
    const body = renderCampaignBody({
      id: "c1",
      status: "sending",
      warmup_status: null,
      daily_cap: 50,
      started_at: "2026-05-10T00:00:00Z",
    });
    expect(body).toMatch(/Live\. Daily cap: 50\./);
  });

  it("paused / ended / failed render their own copy", () => {
    expect(
      renderCampaignBody({
        id: "c1",
        status: "paused",
        warmup_status: null,
        daily_cap: 0,
        started_at: null,
      }),
    ).toBe("Paused.");
    expect(
      renderCampaignBody({
        id: "c1",
        status: "ended",
        warmup_status: null,
        daily_cap: 0,
        started_at: null,
      }),
    ).toBe("Campaign ended.");
    expect(
      renderCampaignBody({
        id: "c1",
        status: "failed",
        warmup_status: null,
        daily_cap: 0,
        started_at: null,
      }),
    ).toMatch(/failed — operator is on it/);
  });

  it("unknown status echoes status value", () => {
    expect(
      renderCampaignBody({
        id: "c1",
        status: "weird",
        warmup_status: null,
        daily_cap: 0,
        started_at: null,
      }),
    ).toBe("Status: weird");
  });
});

describe("campaignTone", () => {
  it("undefined → neutral", () => expect(campaignTone(undefined)).toBe("neutral"));
  it("sending → good", () => expect(campaignTone("sending")).toBe("good"));
  it("failed → bad", () => expect(campaignTone("failed")).toBe("bad"));
  it("anything else → pending", () => {
    expect(campaignTone("warmup")).toBe("pending");
    expect(campaignTone("paused")).toBe("pending");
    expect(campaignTone("ended")).toBe("pending");
    expect(campaignTone("anything")).toBe("pending");
  });
});

describe("renderPerformanceBody", () => {
  it("returns no-data message when snapshot is null", () => {
    expect(renderPerformanceBody(null)).toMatch(/No data yet/);
  });

  it("renders snapshot with uplift", () => {
    expect(
      renderPerformanceBody({
        snapshot_date: "2026-05-10",
        opens: 40,
        replies: 4,
        meetings_booked: 1,
        baseline_reply_rate: 0.02,
        current_reply_rate: 0.04,
        uplift_pct: 100,
      }),
    ).toBe("As of 2026-05-10: 4 replies, 1 meetings. Uplift 100.0%.");
  });

  it("uses em-dash when uplift_pct is null", () => {
    expect(
      renderPerformanceBody({
        snapshot_date: "2026-05-10",
        opens: 40,
        replies: 4,
        meetings_booked: 1,
        baseline_reply_rate: null,
        current_reply_rate: 0.04,
        uplift_pct: null,
      }),
    ).toMatch(/Uplift —\.$/);
  });
});

describe("performanceTone", () => {
  it("null → neutral", () => expect(performanceTone(null)).toBe("neutral"));
  it(">= 10 → good", () => {
    expect(performanceTone(10)).toBe("good");
    expect(performanceTone(50)).toBe("good");
  });
  it("< 0 → bad", () => {
    expect(performanceTone(-1)).toBe("bad");
    expect(performanceTone(-100)).toBe("bad");
  });
  it("0..9.99 → pending", () => {
    expect(performanceTone(0)).toBe("pending");
    expect(performanceTone(9.9)).toBe("pending");
  });
});
