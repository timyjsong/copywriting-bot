import { describe, expect, it } from "vitest";
import {
  RoastResult,
  OnboardingPayload,
  ApprovalDecision,
  ApprovalType,
  BrandVoiceProfile,
  IcpDefinition,
} from "./index.js";

const VALID_ROAST = {
  is_real_cold_email: true,
  refusal_reason: null,
  overall_score: 73,
  per_dimension: [
    { dimension: "subject_line", score: 6, rationale: "ok" },
    { dimension: "opener_personalization", score: 7, rationale: "ok" },
    { dimension: "value_clarity", score: 8, rationale: "ok" },
    { dimension: "social_proof", score: 5, rationale: "ok" },
    { dimension: "cta_strength", score: 7, rationale: "ok" },
    { dimension: "sequencing", score: 8, rationale: "ok" },
  ],
  worst_email_index: 0,
  rewrite_preview: { subject: "s", body: "b", changed_phrases: [] },
  share_caption: "ok",
};

describe("RoastResult", () => {
  it("accepts a valid roast result", () => {
    expect(RoastResult.safeParse(VALID_ROAST).success).toBe(true);
  });

  it("requires exactly 6 dimension scores", () => {
    const bad = { ...VALID_ROAST, per_dimension: VALID_ROAST.per_dimension.slice(0, 5) };
    expect(RoastResult.safeParse(bad).success).toBe(false);
  });

  it("rejects scores out of 0-10", () => {
    const bad = {
      ...VALID_ROAST,
      per_dimension: VALID_ROAST.per_dimension.map((d, i) => (i === 0 ? { ...d, score: 12 } : d)),
    };
    expect(RoastResult.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown dimension", () => {
    const bad = {
      ...VALID_ROAST,
      per_dimension: [...VALID_ROAST.per_dimension.slice(0, 5), { dimension: "vibes", score: 5, rationale: "x" }],
    };
    expect(RoastResult.safeParse(bad).success).toBe(false);
  });
});

const VALID_ONBOARDING = {
  customer_id: "00000000-0000-0000-0000-000000000001",
  sending_domain: "out.acme.com",
  original_sequence: "Subject: hi\n\nHey, this is at least forty characters long so the validator is happy.",
  icp_paragraph: "Series A B2B SaaS founders selling to other SaaS teams with reply rates under 3%.",
  sample_target_companies: ["linear.app", "vercel.com", "supabase.com"],
  calendar_url: "https://calendly.com/me/30",
  brand_voice_url: "https://acme.com",
};

describe("OnboardingPayload", () => {
  it("accepts a valid payload", () => {
    expect(OnboardingPayload.safeParse(VALID_ONBOARDING).success).toBe(true);
  });

  it("rejects non-UUID customer_id", () => {
    const bad = { ...VALID_ONBOARDING, customer_id: "not-a-uuid" };
    expect(OnboardingPayload.safeParse(bad).success).toBe(false);
  });

  it("requires at least 3 sample target companies", () => {
    const bad = { ...VALID_ONBOARDING, sample_target_companies: ["linear.app"] };
    expect(OnboardingPayload.safeParse(bad).success).toBe(false);
  });

  it("requires a valid URL for calendar + brand_voice", () => {
    const bad = { ...VALID_ONBOARDING, calendar_url: "not a url" };
    expect(OnboardingPayload.safeParse(bad).success).toBe(false);
  });
});

describe("ApprovalDecision", () => {
  it("accepts a bare approve", () => {
    const out = ApprovalDecision.safeParse({
      approval_id: "00000000-0000-0000-0000-000000000001",
      decision: "approve",
    });
    expect(out.success).toBe(true);
  });

  it("accepts edit_and_approve with a payload", () => {
    const out = ApprovalDecision.safeParse({
      approval_id: "00000000-0000-0000-0000-000000000001",
      decision: "edit_and_approve",
      edited_payload: { foo: "bar" },
      notes: "tweaked the subject",
    });
    expect(out.success).toBe(true);
  });

  it("rejects unknown decision values", () => {
    const out = ApprovalDecision.safeParse({
      approval_id: "00000000-0000-0000-0000-000000000001",
      decision: "maybe",
    });
    expect(out.success).toBe(false);
  });
});

describe("ApprovalType enum", () => {
  it("covers all 5 PRD-defined approval types", () => {
    const all = ["rewrite", "send_batch", "refund", "outbound_email", "support_reply"];
    for (const t of all) expect(ApprovalType.safeParse(t).success).toBe(true);
  });
});

describe("BrandVoiceProfile", () => {
  it("accepts a typical profile", () => {
    const out = BrandVoiceProfile.safeParse({
      tone: ["plainspoken", "technical"],
      positioning: "We're the bot that rewrites cold emails.",
      key_phrases: ["B2B SaaS", "reply rate"],
      avoid_phrases: ["synergy", "leverage"],
      reading_level: "accessible",
      source_urls: ["https://acme.com"],
    });
    expect(out.success).toBe(true);
  });

  it("requires at least one tone descriptor", () => {
    const out = BrandVoiceProfile.safeParse({
      tone: [],
      positioning: "x",
      key_phrases: [],
      avoid_phrases: [],
      reading_level: "accessible",
      source_urls: [],
    });
    expect(out.success).toBe(false);
  });
});

describe("IcpDefinition", () => {
  it("requires at least one geo from the supported set", () => {
    const out = IcpDefinition.safeParse({
      industry: "B2B SaaS",
      company_stage: "Series A",
      size_range: "20-80",
      buyer_titles: ["Head of Growth"],
      pain_signals: ["reply rate <3%"],
      geo: [],
    });
    expect(out.success).toBe(false);
  });

  it("rejects geos outside US/UK/CA/AU", () => {
    const out = IcpDefinition.safeParse({
      industry: "B2B SaaS",
      company_stage: "Series A",
      size_range: "20-80",
      buyer_titles: ["Head of Growth"],
      pain_signals: ["reply rate <3%"],
      geo: ["DE"],
    });
    expect(out.success).toBe(false);
  });

  it("accepts the canonical four geos", () => {
    const out = IcpDefinition.safeParse({
      industry: "B2B SaaS",
      company_stage: "Series A",
      size_range: "20-80",
      buyer_titles: ["Head of Growth"],
      pain_signals: ["reply rate <3%"],
      geo: ["US", "UK", "CA", "AU"],
    });
    expect(out.success).toBe(true);
  });
});
