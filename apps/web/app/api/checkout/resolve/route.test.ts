import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real handler tests for /api/checkout/resolve. Covers every branch:
 * invalid-JSON, invalid-schema (drift-protected by importing `Body`), 202
 * not_paid, 410 missing-email, 202 webhook_pending, 500 DB error, 500 Stripe
 * retrieve throw, and the 200 success path.
 *
 * Stripe + Supabase are mocked at module boundary. The route's lazy Stripe
 * singleton is reset by re-importing the module in `beforeEach`.
 */

const stripeRetrieveMock = vi.fn();
const maybeSingleMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    checkout: { sessions: { retrieve: stripeRetrieveMock } },
  })),
}));

vi.mock("@copywriting-bot/shared/env", () => ({
  serverEnv: () => ({ STRIPE_SECRET_KEY: "sk_test_xxx" }),
}));

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
      }),
    }),
  }),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureException: captureExceptionMock,
}));

type RouteModule = typeof import("./route.js");
let POST: RouteModule["POST"];
// Body schema is imported from a sibling module (Next.js disallows arbitrary
// exports from route.ts). Imported once here; the schema-drift test uses it.
import { ResolveCheckoutBody as Body } from "./schema.js";

beforeEach(async () => {
  vi.resetModules();
  stripeRetrieveMock.mockReset();
  maybeSingleMock.mockReset();
  captureExceptionMock.mockReset();
  const mod = await import("./route.js");
  POST = mod.POST;
});

afterEach(() => {
  vi.clearAllMocks();
});

function postJson(body: unknown): Request {
  return new Request("http://test/api/checkout/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("checkout/resolve Body schema (imported, not duplicated)", () => {
  it("accepts a Stripe-shaped session id", () => {
    expect(Body.safeParse({ session_id: "cs_test_a1b2c3d4e5f6" }).success).toBe(true);
  });

  it("rejects empty / short / missing session id", () => {
    expect(Body.safeParse({ session_id: "" }).success).toBe(false);
    expect(Body.safeParse({ session_id: "cs_x" }).success).toBe(false);
    expect(Body.safeParse({}).success).toBe(false);
  });
});

describe("POST /api/checkout/resolve", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const req = new Request("http://test/api/checkout/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("returns 400 when session_id is missing/invalid", async () => {
    const res = await POST(postJson({ session_id: "x" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid session_id" });
  });

  it("returns 202 pending with reason=not_paid when payment not yet completed", async () => {
    stripeRetrieveMock.mockResolvedValueOnce({ payment_status: "unpaid" });
    const res = await POST(postJson({ session_id: "cs_test_a1b2c3d4e5f6" }));
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ pending: true, reason: "not_paid" });
  });

  it("returns 410 when paid session has no email", async () => {
    stripeRetrieveMock.mockResolvedValueOnce({
      payment_status: "paid",
      customer_details: null,
      customer_email: null,
    });
    const res = await POST(postJson({ session_id: "cs_test_a1b2c3d4e5f6" }));
    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({ error: "Session missing email" });
  });

  it("returns 500 with captureException when DB lookup errors", async () => {
    stripeRetrieveMock.mockResolvedValueOnce({
      payment_status: "paid",
      customer_email: "u@example.com",
    });
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: new Error("db down") });
    const res = await POST(postJson({ session_id: "cs_test_a1b2c3d4e5f6" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "DB error" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "resolve_customer" }),
    );
  });

  it("returns 202 pending with reason=webhook_pending when customer row not yet present", async () => {
    stripeRetrieveMock.mockResolvedValueOnce({
      payment_status: "paid",
      customer_email: "u@example.com",
    });
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(postJson({ session_id: "cs_test_a1b2c3d4e5f6" }));
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ pending: true, reason: "webhook_pending" });
  });

  it("returns 200 with customer_id when Stripe + DB both resolve", async () => {
    stripeRetrieveMock.mockResolvedValueOnce({
      payment_status: "paid",
      customer_details: { email: "u@example.com" },
    });
    maybeSingleMock.mockResolvedValueOnce({
      data: { id: "11111111-1111-1111-1111-111111111111", status: "onboarding" },
      error: null,
    });
    const res = await POST(postJson({ session_id: "cs_test_a1b2c3d4e5f6" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      customer_id: "11111111-1111-1111-1111-111111111111",
      status: "onboarding",
      email: "u@example.com",
    });
  });

  it("returns 500 and captures when Stripe retrieve throws", async () => {
    stripeRetrieveMock.mockRejectedValueOnce(new Error("stripe boom"));
    const res = await POST(postJson({ session_id: "cs_test_a1b2c3d4e5f6" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "Could not resolve session" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "resolve_session" }),
    );
  });
});
