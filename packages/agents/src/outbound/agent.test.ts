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

import { runOutboundAgent, type OutboundProspect } from "./agent.js";

const prospect: OutboundProspect = {
  id: "p1",
  name: "Jane Roe",
  role: "Founder",
  company: "Foo SaaS",
  company_domain: "foosaas.example",
  signal: "Launched analytics dashboard last week",
};

const validResult = {
  messages: [
    {
      prospect_id: "p1",
      subject: "saw your dashboard launch",
      body: "Hi Jane — saw Foo SaaS shipped the new analytics dashboard last week. Most founders hit a reply-rate wall right after big launches. Want me to send a 60-second video roast of your current sequence?",
      signal_used: "Launched analytics dashboard last week",
      guardrail_flags: [],
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

describe("runOutboundAgent", () => {
  it("rejects empty prospect list without LLM call", async () => {
    const out = await runOutboundAgent([]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/No prospects/i);
    expect(callJsonAgentMock).not.toHaveBeenCalled();
  });

  it("rejects batches over 100 prospects", async () => {
    const big: OutboundProspect[] = Array.from({ length: 101 }, (_, i) => ({
      ...prospect,
      id: `p${i}`,
    }));
    const out = await runOutboundAgent(big);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/split it/);
    expect(callJsonAgentMock).not.toHaveBeenCalled();
  });

  it("returns ok on the happy path", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: JSON.stringify(validResult), usage: null });
    const out = await runOutboundAgent([prospect]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.messages).toHaveLength(1);
      expect(out.result.messages[0]?.prospect_id).toBe("p1");
    }
  });

  it("captures LLM failures", async () => {
    callJsonAgentMock.mockRejectedValueOnce(new Error("anthropic down"));
    const out = await runOutboundAgent([prospect]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not reach/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "outbound", phase: "llm_call" }),
    );
  });

  it("returns schema mismatch when subject exceeds 120 chars", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({
        messages: [{ ...validResult.messages[0], subject: "x".repeat(130) }],
      }),
      usage: null,
    });
    const out = await runOutboundAgent([prospect]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/i);
  });

  it("returns unparseable error when output is garbage", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: "what even is this", usage: null });
    const out = await runOutboundAgent([prospect]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unparseable/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "outbound", phase: "json_parse" }),
    );
  });
});
