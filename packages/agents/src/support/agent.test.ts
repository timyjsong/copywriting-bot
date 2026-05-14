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

import { runSupportAgent, type SupportInput } from "./agent.js";

const baseInput: SupportInput = {
  customer_email: "user@example.com",
  subject: "I want a refund",
  body: "Three weeks in, no replies. Please refund.",
  recent_thread: "(no prior messages)",
  twenty_one_day_metric_missed: true,
};

beforeEach(() => {
  callJsonAgentMock.mockReset();
  captureExceptionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runSupportAgent", () => {
  it("returns refund triage on the happy path", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({
        category: "refund_request",
        urgency: "high",
        draft_reply: "Hi — totally understand. Processing refund within 24 hours.",
        operator_notes: "21-day metric missed; auto-refund authorized.",
        auto_offer_refund: true,
      }),
      usage: null,
    });
    const out = await runSupportAgent(baseInput);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.triage.category).toBe("refund_request");
      expect(out.triage.auto_offer_refund).toBe(true);
    }
  });

  it("supports spam category with absent draft_reply", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({
        category: "spam",
        urgency: "low",
        operator_notes: "Auto-reply",
        auto_offer_refund: false,
      }),
      usage: null,
    });
    const out = await runSupportAgent({ ...baseInput, body: "Unsubscribe", twenty_one_day_metric_missed: false });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.triage.category).toBe("spam");
  });

  it("captures + returns friendly error when the LLM throws", async () => {
    callJsonAgentMock.mockRejectedValueOnce(new Error("anthropic 500"));
    const out = await runSupportAgent(baseInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not reach/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "support", phase: "llm_call" }),
    );
  });

  it("flags schema mismatch when category is unknown", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({
        category: "not_a_real_category",
        urgency: "low",
        operator_notes: "",
        auto_offer_refund: false,
      }),
      usage: null,
    });
    const out = await runSupportAgent(baseInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/i);
  });

  it("reports unparseable output", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: "no json here", usage: null });
    const out = await runSupportAgent(baseInput);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unparseable/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "support", phase: "json_parse" }),
    );
  });
});
