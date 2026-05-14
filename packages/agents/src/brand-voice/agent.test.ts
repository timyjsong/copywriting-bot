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

import { runBrandVoiceAgent } from "./agent.js";

const validProfile = {
  tone: ["plainspoken", "technical"],
  positioning: "We help SaaS teams turn outbound into a measurable channel.",
  key_phrases: ["measurable", "founder-led"],
  avoid_phrases: ["world-class"],
  reading_level: "professional",
  source_urls: ["https://acme.example.com/"],
};

const longContent = "About Acme. ".repeat(20) + "We build outbound infra for SaaS founders.";

beforeEach(() => {
  callJsonAgentMock.mockReset();
  captureExceptionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runBrandVoiceAgent", () => {
  it("rejects thin content without calling the model", async () => {
    const out = await runBrandVoiceAgent({ url: "https://x.test", content: "hi" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Not enough content/i);
    expect(callJsonAgentMock).not.toHaveBeenCalled();
  });

  it("returns a validated profile on the happy path", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: JSON.stringify(validProfile), usage: null });
    const out = await runBrandVoiceAgent({
      url: "https://acme.example.com/",
      content: longContent,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.reading_level).toBe("professional");
  });

  it("captures and returns a friendly error when LLM throws", async () => {
    callJsonAgentMock.mockRejectedValueOnce(new Error("net down"));
    const out = await runBrandVoiceAgent({ url: "https://acme.example.com/", content: longContent });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/could not reach the model/i);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "brand_voice", phase: "llm_call" }),
    );
  });

  it("reports unparseable output", async () => {
    callJsonAgentMock.mockResolvedValueOnce({ raw: "<not json>", usage: null });
    const out = await runBrandVoiceAgent({ url: "https://acme.example.com/", content: longContent });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/unparseable/i);
  });

  it("reports schema mismatch when JSON does not match BrandVoiceProfile", async () => {
    callJsonAgentMock.mockResolvedValueOnce({
      raw: JSON.stringify({ ...validProfile, reading_level: "scholarly" }),
      usage: null,
    });
    const out = await runBrandVoiceAgent({ url: "https://acme.example.com/", content: longContent });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/schema/i);
  });

  it("truncates very long content to 15k chars in the user message", async () => {
    let capturedUser: string | undefined;
    callJsonAgentMock.mockImplementationOnce(async (opts: { userMessage: string }) => {
      capturedUser = opts.userMessage;
      return { raw: JSON.stringify(validProfile), usage: null };
    });
    const huge = "x".repeat(20_000);
    const out = await runBrandVoiceAgent({ url: "https://acme.example.com/", content: huge });
    expect(out.ok).toBe(true);
    expect(capturedUser).toBeDefined();
    // Header "URL: ...\n\nContent:\n" + 15k chars
    expect(capturedUser!.endsWith("x".repeat(15_000))).toBe(true);
  });
});
