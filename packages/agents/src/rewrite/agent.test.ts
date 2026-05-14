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
  return {
    ...actual,
    callJsonAgent: callJsonAgentMock,
  };
});

vi.mock("@copywriting-bot/shared/observability", () => ({
  addBreadcrumb: vi.fn(),
  captureException: captureExceptionMock,
}));

import { runRewriteAgent, type RewriteInput } from "./agent.js";
import type { BrandVoiceProfileT, IcpDefinitionT } from "@copywriting-bot/shared/schemas";

const validBrandVoice: BrandVoiceProfileT = {
  tone: ["plainspoken", "technical"],
  positioning: "We help SaaS teams write better cold emails.",
  key_phrases: ["productized", "founder-led"],
  avoid_phrases: ["synergy", "world-class"],
  reading_level: "professional",
  source_urls: ["https://acme.example.com"],
};

const validIcp: IcpDefinitionT = {
  industry: "B2B SaaS",
  company_stage: "Series A-B",
  size_range: "20-200",
  buyer_titles: ["Founder", "Head of Growth"],
  pain_signals: ["low reply rate", "no SDR"],
  geo: ["US", "UK"],
};

const validInput: RewriteInput = {
  original_sequence: "Subject: hello\nBody: trying this out\n\nSubject: bump\nBody: thoughts?",
  brand_voice: validBrandVoice,
  icp: validIcp,
  customer_id: "11111111-1111-1111-1111-111111111111",
};

const validResultJson = {
  emails: [
    {
      step: 1,
      purpose: "open",
      send_delay_days: 0,
      subject: "saw you shipped dashboards",
      body: "Hi {{first_name}}, noticed you launched the new analytics dashboard last week — congrats. Most teams hit a wall scaling outbound at this stage; happy to send a 60-second teardown of your current sequence if useful.",
      personalisation_tokens: ["{{first_name}}"],
      diff_summary: "Replaced platitude opener with a specific launch signal.",
      new_claims: [],
    },
    {
      step: 2,
      purpose: "follow_up",
      send_delay_days: 3,
      subject: "quick bump",
      body: "Hi {{first_name}}, did the teardown idea land? Three companies in your space have run it this month — happy to share what stood out. Worth a look?",
      personalisation_tokens: ["{{first_name}}"],
      diff_summary: "Added social proof (anonymised) and a softer CTA.",
      new_claims: ["Three companies in your space have run it this month."],
    },
  ],
  playbook_used: "specific-signal-open + soft-social-proof",
  expected_reply_rate_band: "4-7%",
  guardrail_flags: [],
  rationale: "Anchored opener on a verifiable launch signal; reused customer's vocabulary; trimmed CTA to one specific ask per email.",
};

beforeEach(() => {
  callJsonAgentMock.mockReset();
  captureExceptionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runRewriteAgent", () => {
  it("returns ok with a validated result on the happy path", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify(validResultJson),
      usage: null,
    });
    const out = await runRewriteAgent(validInput);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.emails).toHaveLength(2);
      expect(out.result.expected_reply_rate_band).toBe("4-7%");
    }
  });

  it("rejects invalid brand voice without calling the model", async () => {
    const out = await runRewriteAgent({
      ...validInput,
      brand_voice: { ...validBrandVoice, tone: [] } as unknown as BrandVoiceProfileT,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Brand voice/i);
    expect(callJsonAgentMock).not.toHaveBeenCalled();
  });

  it("rejects invalid ICP without calling the model", async () => {
    const out = await runRewriteAgent({
      ...validInput,
      icp: { ...validIcp, buyer_titles: [] } as unknown as IcpDefinitionT,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/ICP/i);
    expect(callJsonAgentMock).not.toHaveBeenCalled();
  });

  it("captures and returns a friendly error when the LLM call throws", async () => {
    callJsonAgentMock.mockRejectedValueOnce(new Error("anthropic 529"));
    const out = await runRewriteAgent(validInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not reach the model/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "rewrite", phase: "llm_call" }),
    );
  });

  it("returns parse error when model emits non-JSON output", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: "literally not json", usage: null });
    const out = await runRewriteAgent(validInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unparseable/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "rewrite", phase: "json_parse" }),
    );
  });

  it("returns schema mismatch error when JSON is parseable but wrong shape", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({ ...validResultJson, expected_reply_rate_band: "99%" }),
      usage: null,
    });
    const out = await runRewriteAgent(validInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "rewrite", phase: "schema" }),
    );
  });

  it("accepts fenced ```json``` output from the model", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: "Sure, here you go:\n```json\n" + JSON.stringify(validResultJson) + "\n```",
      usage: null,
    });
    const out = await runRewriteAgent(validInput);
    expect(out.ok).toBe(true);
  });
});
