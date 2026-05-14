import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for POST /api/refund (operator-initiated refund).
 *
 * Covers every branch:
 *  - 400 invalid JSON body
 *  - 400 schema (missing/invalid customer_id, amount, etc.)
 *  - 404 customer not found
 *  - 500 DB error during customer lookup
 *  - 500 inngest dispatch throws
 *  - 200 happy path → inngest.send called with normalised payload
 */

const customerLookupMaybeSingleMock = vi.fn();
const inngestSendMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: customerLookupMaybeSingleMock }),
      }),
    }),
  }),
}));

vi.mock("@copywriting-bot/inngest/client", () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureException: captureExceptionMock,
}));

type RouteModule = typeof import("./route.js");
let POST: RouteModule["POST"];

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  vi.resetModules();
  customerLookupMaybeSingleMock.mockReset();
  inngestSendMock.mockReset();
  captureExceptionMock.mockReset();
  inngestSendMock.mockResolvedValue({});
  const mod = await import("./route.js");
  POST = mod.POST;
});

afterEach(() => {
  vi.clearAllMocks();
});

function postJson(body: unknown): Request {
  return new Request("http://ops.test/api/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/refund", () => {
  it("returns 400 on invalid JSON", async () => {
    const res = await POST(
      new Request("http://ops.test/api/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON" });
  });

  it("returns 400 when required fields are missing or invalid", async () => {
    const res = await POST(postJson({ customer_id: "not-a-uuid", stripe_charge_id: "" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when amount is < 1 (zod min)", async () => {
    const res = await POST(
      postJson({
        customer_id: VALID_UUID,
        stripe_charge_id: "ch_test_123",
        amount: 0,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when customer is not found", async () => {
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(
      postJson({
        customer_id: VALID_UUID,
        stripe_charge_id: "ch_test_123",
        amount: 29700,
      }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "Customer not found" });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("returns 404 (and skips inngest) when DB lookup errors", async () => {
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: null, error: new Error("db down") });
    const res = await POST(
      postJson({
        customer_id: VALID_UUID,
        stripe_charge_id: "ch_test_123",
        amount: 29700,
      }),
    );
    expect(res.status).toBe(404);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("returns 500 and captures when inngest.send throws", async () => {
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: { id: VALID_UUID }, error: null });
    inngestSendMock.mockRejectedValueOnce(new Error("inngest boom"));
    const res = await POST(
      postJson({
        customer_id: VALID_UUID,
        stripe_charge_id: "ch_test_123",
        amount: 29700,
      }),
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "Could not dispatch refund" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "operator_refund_request" }),
    );
  });

  it("returns 200 and dispatches refund/requested on the happy path", async () => {
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: { id: VALID_UUID }, error: null });
    const res = await POST(
      postJson({
        customer_id: VALID_UUID,
        stripe_charge_id: "ch_test_123",
        amount: 29700,
        reason: "21-day miss",
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "refund/requested",
        data: expect.objectContaining({
          customer_id: VALID_UUID,
          stripe_charge_id: "ch_test_123",
          amount: 29700,
          currency: "usd",
          reason: "21-day miss",
        }),
      }),
    );
  });

  it("defaults currency to usd and reason to empty string when omitted", async () => {
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: { id: VALID_UUID }, error: null });
    await POST(
      postJson({
        customer_id: VALID_UUID,
        stripe_charge_id: "ch_test_123",
        amount: 29700,
      }),
    );
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: "usd", reason: "" }),
      }),
    );
  });
});
