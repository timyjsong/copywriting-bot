if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = "test-supabase-key";
if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
if (!process.env.STRIPE_WEBHOOK_SECRET) process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { callJsonAgentMock, captureExceptionMock } = vi.hoisted(() => ({
  callJsonAgentMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock("../client.js", async () => {
  const actual = await vi.importActual<typeof import("../client.js")>("../client.js");
  return { ...actual, callJsonAgent: callJsonAgentMock };
});

vi.mock("@copywriting-bot/shared/observability", () => ({
  addBreadcrumb: vi.fn(),
  captureException: captureExceptionMock,
}));

import { generateWarmupPlan, personaliseBatch, type WarmupInput, type PersonaliseInput } from "./agent.js";
import type { BrandVoiceProfileT, IcpDefinitionT } from "@copywriting-bot/shared/schemas";

const validWarmup = {
  schedule: Array.from({ length: 10 }, (_, i) => ({
    day: i + 1,
    max_sends: 10 + i * 5,
    ramp_reason: "gradual ramp",
  })),
  final_daily_cap: 60,
  abort_conditions: ["bounce_rate > 3%", "spam_complaint_rate > 0.1%"],
};

const warmupInput: WarmupInput = {
  customer_id: "11111111-1111-1111-1111-111111111111",
  sending_domain: "outbound.acme.example",
  domain_age_days: 35,
  prior_send_volume_30d: 0,
  target_daily_cap: 60,
};

const brandVoice: BrandVoiceProfileT = {
  tone: ["plainspoken"],
  positioning: "We help SaaS founders write better cold emails.",
  key_phrases: ["measurable"],
  avoid_phrases: ["synergy"],
  reading_level: "professional",
  source_urls: ["https://acme.example.com"],
};

const icp: IcpDefinitionT = {
  industry: "B2B SaaS",
  company_stage: "Series A",
  size_range: "20-200",
  buyer_titles: ["Founder"],
  pain_signals: ["low reply rate"],
  geo: ["US"],
};

const personaliseInput: PersonaliseInput = {
  template_subject: "saw you launched",
  template_body: "Hi {{first_name}}, noticed {{company}} shipped something cool last week. Want a 60-second teardown of your current sequence?",
  brand_voice: brandVoice,
  icp,
  prospects: [{ id: "p1", name: "Jane", company: "FooCo", signal: "launch" }],
};

const validPersonalise = {
  messages: [
    {
      prospect_id: "p1",
      subject: "saw you launched",
      body: "Hi Jane, noticed FooCo shipped something cool last week. Want a 60-second teardown of your current sequence?",
      personalised_lines: ["Hi Jane, noticed FooCo shipped something cool last week."],
    },
  ],
};

beforeEach(() => {
  callJsonAgentMock.mockReset();
  captureExceptionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("generateWarmupPlan", () => {
  it("returns ok with a validated plan on happy path", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: JSON.stringify(validWarmup), usage: null });
    const out = await generateWarmupPlan(warmupInput);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.plan.schedule).toHaveLength(10);
      expect(out.plan.final_daily_cap).toBe(60);
    }
  });

  it("captures and returns error when LLM throws", async () => {
    callJsonAgentMock.mockRejectedValueOnce(new Error("net"));
    const out = await generateWarmupPlan(warmupInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not reach/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "send_infra", phase: "warmup_plan" }),
    );
  });

  it("reports schema mismatch when schedule is shorter than minimum", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({ ...validWarmup, schedule: validWarmup.schedule.slice(0, 3) }),
      usage: null,
    });
    const out = await generateWarmupPlan(warmupInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/i);
  });

  it("returns unparseable error on bad JSON", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: "nope", usage: null });
    const out = await generateWarmupPlan(warmupInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unparseable/i);
  });
});

describe("personaliseBatch", () => {
  it("rejects empty batches without LLM call", async () => {
    const out = await personaliseBatch({ ...personaliseInput, prospects: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/No prospects/i);
    expect(callJsonAgentMock).not.toHaveBeenCalled();
  });

  it("returns personalised messages on happy path", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: JSON.stringify(validPersonalise), usage: null });
    const out = await personaliseBatch(personaliseInput);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.messages).toHaveLength(1);
      expect(out.result.messages[0]?.prospect_id).toBe("p1");
    }
  });

  it("captures LLM failures", async () => {
    callJsonAgentMock.mockRejectedValueOnce(new Error("nope"));
    const out = await personaliseBatch(personaliseInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not reach/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "send_infra", phase: "personalise" }),
    );
  });

  it("reports schema mismatch when subject is empty", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({
        messages: [{ ...validPersonalise.messages[0], subject: "" }],
      }),
      usage: null,
    });
    const out = await personaliseBatch(personaliseInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/i);
  });

  it("reports unparseable on bad output", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: "nada", usage: null });
    const out = await personaliseBatch(personaliseInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unparseable/i);
  });
});
