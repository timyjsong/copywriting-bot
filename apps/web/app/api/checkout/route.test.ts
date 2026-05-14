import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for POST /api/checkout (Stripe Checkout Session creation).
 * Covers:
 *  - 400 on invalid schema (non-email, bad UUID)
 *  - 500 + capture when Stripe throws
 *  - happy path: returns session.url, passes email + metadata correctly
 *  - empty/no-JSON body still succeeds (Body fields all optional)
 *  - uses STRIPE_PRICE_ID_FULL_REWRITE branch when env set
 *  - falls back to inline price_data when env price-id is absent
 */

const sessionsCreateMock = vi.fn();
const captureExceptionMock = vi.fn();
const serverEnvMock = vi.fn();

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: sessionsCreateMock } },
  })),
}));

vi.mock("@copywriting-bot/shared/env", () => ({
  serverEnv: () => serverEnvMock(),
  publicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://copywritingbot.test" }),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureException: captureExceptionMock,
}));

type RouteModule = typeof import("./route.js");
let POST: RouteModule["POST"];

beforeEach(async () => {
  vi.resetModules();
  sessionsCreateMock.mockReset();
  captureExceptionMock.mockReset();
  serverEnvMock.mockReset();
  serverEnvMock.mockReturnValue({
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_PRICE_ID_FULL_REWRITE: "",
  });
  const mod = await import("./route.js");
  POST = mod.POST;
});

afterEach(() => {
  vi.clearAllMocks();
});

function postJson(body: unknown): Request {
  return new Request("http://test/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/checkout", () => {
  it("returns 400 when email is not a valid email", async () => {
    const res = await POST(postJson({ email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when from_roast_id is not a UUID", async () => {
    const res = await POST(postJson({ from_roast_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with session.url on the happy path", async () => {
    sessionsCreateMock.mockResolvedValueOnce({
      url: "https://checkout.stripe.test/cs_test_xyz",
    });
    const res = await POST(postJson({ email: "u@example.com" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ url: "https://checkout.stripe.test/cs_test_xyz" });
    const args = sessionsCreateMock.mock.calls[0]?.[0];
    expect(args.customer_email).toBe("u@example.com");
    expect(args.success_url).toMatch(/copywritingbot\.test\/onboarding\?session_id=/);
    expect(args.cancel_url).toMatch(/copywritingbot\.test\/pricing\?cancelled=1/);
  });

  it("forwards from_roast_id as metadata when provided", async () => {
    sessionsCreateMock.mockResolvedValueOnce({ url: "https://x.test" });
    await POST(
      postJson({
        email: "u@example.com",
        from_roast_id: "11111111-1111-1111-1111-111111111111",
      }),
    );
    const args = sessionsCreateMock.mock.calls[0]?.[0];
    expect(args.metadata).toEqual({ from_roast_id: "11111111-1111-1111-1111-111111111111" });
  });

  it("uses STRIPE_PRICE_ID_FULL_REWRITE when set", async () => {
    serverEnvMock.mockReturnValue({
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_PRICE_ID_FULL_REWRITE: "price_abc123",
    });
    sessionsCreateMock.mockResolvedValueOnce({ url: "https://x.test" });
    await POST(postJson({ email: "u@example.com" }));
    const args = sessionsCreateMock.mock.calls[0]?.[0];
    expect(args.line_items[0]).toEqual({ price: "price_abc123", quantity: 1 });
  });

  it("falls back to inline price_data when STRIPE_PRICE_ID_FULL_REWRITE is empty", async () => {
    sessionsCreateMock.mockResolvedValueOnce({ url: "https://x.test" });
    await POST(postJson({ email: "u@example.com" }));
    const args = sessionsCreateMock.mock.calls[0]?.[0];
    expect(args.line_items[0].price_data.unit_amount).toBe(29_700);
    expect(args.line_items[0].price_data.currency).toBe("usd");
  });

  it("treats invalid JSON as empty body and still creates a session (email optional)", async () => {
    sessionsCreateMock.mockResolvedValueOnce({ url: "https://x.test" });
    const req = new Request("http://test/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const args = sessionsCreateMock.mock.calls[0]?.[0];
    expect(args.customer_email).toBeUndefined();
  });

  it("returns 500 + captures when Stripe throws", async () => {
    sessionsCreateMock.mockRejectedValueOnce(new Error("stripe down"));
    const res = await POST(postJson({ email: "u@example.com" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "Could not create checkout session" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "create_checkout_session" }),
    );
  });
});
