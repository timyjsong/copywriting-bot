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

import { runRoastAgent } from "./agent.js";

const validRoastJson = {
  is_real_cold_email: true,
  refusal_reason: null,
  overall_score: 42,
  per_dimension: [
    { dimension: "subject_line", score: 4, rationale: "generic" },
    { dimension: "opener_personalization", score: 3, rationale: "no signal" },
    { dimension: "value_clarity", score: 5, rationale: "vague" },
    { dimension: "social_proof", score: 2, rationale: "absent" },
    { dimension: "cta_strength", score: 6, rationale: "ok" },
    { dimension: "sequencing", score: 5, rationale: "average" },
  ],
  worst_email_index: 0,
  rewrite_preview: {
    subject: "saw your dashboard launch",
    body: "Quick note — saw you shipped the new dashboard last week. Most teams hit a reply-rate wall right after big launches; happy to send a 60-second teardown if useful.",
    changed_phrases: ["hope this finds you well → saw your dashboard launch"],
  },
  share_caption: "Got a 42/100 on my cold email. Time to fix it. — Copywriting Bot",
};

beforeEach(() => {
  callJsonAgentMock.mockReset();
  captureExceptionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runRoastAgent", () => {
  it("returns ok with parsed result on happy path", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify(validRoastJson),
      usage: { input_tokens: 200, output_tokens: 150 },
    });
    const out = await runRoastAgent({ sequence: "Subject: hello\nBody: hi" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.overall_score).toBe(42);
      expect(out.usage).toEqual({ input: 200, output: 150, cacheHit: false });
    }
  });

  it("reports cache hit when SDK returns cache_read_input_tokens > 0", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify(validRoastJson),
      usage: { input_tokens: 10, output_tokens: 150, cache_read_input_tokens: 200 },
    });
    const out = await runRoastAgent({ sequence: "Subject: hello\nBody: hi" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.usage?.cacheHit).toBe(true);
  });

  it("returns null usage when SDK reports no usage", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: JSON.stringify(validRoastJson), usage: null });
    const out = await runRoastAgent({ sequence: "Subject: x\nBody: y" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.usage).toBeNull();
  });

  it("captures LLM failures and returns a graceful error", async () => {
    callJsonAgentMock.mockRejectedValueOnce(new Error("timeout"));
    const out = await runRoastAgent({ sequence: "Subject: x\nBody: y" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not reach the model/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "roast", phase: "llm_call" }),
    );
  });

  it("reports unparseable model output", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: "not json at all", usage: null });
    const out = await runRoastAgent({ sequence: "Subject: x\nBody: y" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unparseable/i);
  });

  it("rejects valid JSON that fails schema (e.g. 7 per_dimension entries)", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({
        ...validRoastJson,
        per_dimension: [...validRoastJson.per_dimension, { dimension: "subject_line", score: 1, rationale: "x" }],
      }),
      usage: null,
    });
    const out = await runRoastAgent({ sequence: "Subject: x\nBody: y" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/i);
  });

  it("accepts refusal (is_real_cold_email=false) with proper fields", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({
        ...validRoastJson,
        is_real_cold_email: false,
        refusal_reason: "Looks like a marketing newsletter, not a cold email.",
        rewrite_preview: null,
        per_dimension: validRoastJson.per_dimension.map((d) => ({ ...d, score: 0 })),
        overall_score: 0,
      }),
      usage: null,
    });
    const out = await runRoastAgent({ sequence: "Newsletter: 5 product updates" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.is_real_cold_email).toBe(false);
      expect(out.result.refusal_reason).toMatch(/newsletter/);
    }
  });
});
