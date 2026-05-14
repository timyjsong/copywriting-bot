import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for POST /api/stripe/webhook. Stripe verification is mocked so we
 * control which event-shape lands in the handler. Covers:
 *  - 400 missing stripe-signature header
 *  - 400 signature verification failure
 *  - checkout.session.completed: ignored when no email
 *  - checkout.session.completed: 500 when upsert errors
 *  - checkout.session.completed: dispatches stripe/checkout.completed
 *  - charge.refunded: ignored when no email
 *  - charge.refunded: ignored when customer not found
 *  - charge.refunded: dispatches refund/requested
 *  - charge.dispute.created: refund/requested with reason=stripe_dispute
 *  - unknown event types are silently ignored
 *  - 500 when inngest dispatch throws inside switch
 */

const constructEventMock = vi.fn();
const upsertSingleMock = vi.fn();
const customerLookupMaybeSingleMock = vi.fn();
const inngestSendMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    webhooks: { constructEvent: constructEventMock },
  })),
}));

vi.mock("@copywriting-bot/shared/env", () => ({
  serverEnv: () => ({
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  }),
}));

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: () => ({
    from: () => ({
      upsert: () => ({ select: () => ({ single: upsertSingleMock }) }),
      select: () => ({ eq: () => ({ maybeSingle: customerLookupMaybeSingleMock }) }),
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

beforeEach(async () => {
  vi.resetModules();
  constructEventMock.mockReset();
  upsertSingleMock.mockReset();
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

function webhookReq(body: string, withSig = true): Request {
  return new Request("http://test/api/stripe/webhook", {
    method: "POST",
    headers: withSig
      ? { "stripe-signature": "t=1,v1=fake" }
      : {},
    body,
  });
}

describe("POST /api/stripe/webhook", () => {
  it("returns 400 when stripe-signature header is missing", async () => {
    const res = await POST(webhookReq("anything", false));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: /stripe-signature/i });
  });

  it("returns 400 + captures when constructEvent throws (bad sig)", async () => {
    constructEventMock.mockImplementationOnce(() => {
      throw new Error("Webhook signature verification failed");
    });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid signature" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "stripe_webhook", phase: "verify" }),
    );
  });

  it("checkout.session.completed: ignores session with no email", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: { object: { customer_details: null, customer_email: null } },
    });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, ignored: /no email/ });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("checkout.session.completed: returns 500 when upsert errors", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          customer_details: { email: "u@example.com" },
          customer: "cus_123",
        },
      },
    });
    upsertSingleMock.mockResolvedValueOnce({ data: null, error: new Error("db") });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "DB error" });
  });

  it("checkout.session.completed: upserts customer and dispatches stripe/checkout.completed", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          customer_details: { email: "u@example.com" },
          customer: "cus_123",
          amount_total: 29700,
          currency: "usd",
        },
      },
    });
    upsertSingleMock.mockResolvedValueOnce({ data: { id: "cust_1" }, error: null });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        // Event id keyed on stripe session id → Stripe re-delivery dedups
        // at the Inngest layer (iter 23). Without this, retried webhooks
        // would fire `completed_checkout` more than once.
        id: "stripe-checkout-cs_test_1",
        name: "stripe/checkout.completed",
        data: expect.objectContaining({
          stripe_session_id: "cs_test_1",
          stripe_customer_id: "cus_123",
          customer_email: "u@example.com",
          amount_total: 29700,
          currency: "usd",
          created_customer_id: "cust_1",
        }),
      }),
    );
  });

  it("charge.refunded: ignores when neither billing nor receipt email is present", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "charge.refunded",
      data: { object: { id: "ch_1", billing_details: {}, amount: 29700, currency: "usd" } },
    });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, ignored: /no email/ });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("charge.refunded: ignores when customer not found by email", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          billing_details: { email: "missing@example.com" },
          amount: 29700,
          currency: "usd",
        },
      },
    });
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: null });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, ignored: /customer not found/ });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("charge.refunded: dispatches refund/requested with amount_refunded", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_2",
          billing_details: { email: "u@example.com" },
          amount: 29700,
          amount_refunded: 14850,
          currency: "usd",
        },
      },
    });
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: { id: "cust_2" } });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "refund/requested",
        data: expect.objectContaining({
          customer_id: "cust_2",
          stripe_charge_id: "ch_2",
          amount: 14850,
          currency: "usd",
          reason: "stripe_refund",
        }),
      }),
    );
  });

  it("charge.dispute.created: dispatches refund/requested with reason=stripe_dispute", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "charge.dispute.created",
      data: {
        object: {
          id: "ch_3",
          billing_details: { email: "u@example.com" },
          amount: 29700,
          currency: "usd",
        },
      },
    });
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: { id: "cust_3" } });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(200);
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: "stripe_dispute", amount: 29700 }),
      }),
    );
  });

  it("ignores unknown event types and returns received:true without dispatch", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "customer.created",
      data: { object: { id: "cus_x" } },
    });
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("returns 500 + captures when inngest dispatch throws inside switch", async () => {
    constructEventMock.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_x",
          customer_details: { email: "u@example.com" },
          customer: "cus_x",
        },
      },
    });
    upsertSingleMock.mockResolvedValueOnce({ data: { id: "cust_x" }, error: null });
    inngestSendMock.mockRejectedValueOnce(new Error("dispatch fail"));
    const res = await POST(webhookReq("{}"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "Dispatch error" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ agent: "stripe_webhook", phase: "dispatch" }),
    );
  });
});
