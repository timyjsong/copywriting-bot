import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for /api/onboarding. Iteration 3 added a `customer_id` (UUID) branch
 * that takes precedence over `stripe_session_id`. These tests defend:
 *  - the new customer_id branch (happy path, used directly without DB lookup)
 *  - precedence: customer_id wins when both are sent
 *  - invalid UUID rejection (raw zod schema error)
 *  - fallback to stripe_session_id when customer_id is absent
 *  - 400 when neither resolves to a customer
 *  - 400 on invalid JSON body
 *  - the existing invalid-shape branch (missing required fields)
 */

const insertSingleMock = vi.fn();
const customerLookupMaybeSingleMock = vi.fn();
const customerUpdateEqMock = vi.fn();
const reviewMock = vi.fn();
const inngestSendMock = vi.fn();
const captureServerEventSafeMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "customers") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({ maybeSingle: customerLookupMaybeSingleMock }),
              }),
            }),
          }),
          update: () => ({ eq: customerUpdateEqMock }),
        };
      }
      if (table === "sequences") {
        return {
          insert: () => ({
            select: () => ({ single: insertSingleMock }),
          }),
        };
      }
      return {};
    },
  }),
}));

vi.mock("@copywriting-bot/agents/onboarder", () => ({
  reviewOnboardingPayload: (...args: unknown[]) => reviewMock(...args),
}));

vi.mock("@copywriting-bot/inngest/client", () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureException: captureExceptionMock,
  captureServerEventSafe: captureServerEventSafeMock,
}));

type RouteModule = typeof import("./route.js");
let POST: RouteModule["POST"];

beforeEach(async () => {
  vi.resetModules();
  insertSingleMock.mockReset();
  customerLookupMaybeSingleMock.mockReset();
  customerUpdateEqMock.mockReset();
  reviewMock.mockReset();
  inngestSendMock.mockReset();
  captureServerEventSafeMock.mockReset();
  captureExceptionMock.mockReset();
  reviewMock.mockReturnValue({ ok: true });
  customerUpdateEqMock.mockResolvedValue({ data: null, error: null });
  inngestSendMock.mockResolvedValue({});
  captureServerEventSafeMock.mockResolvedValue(undefined);
  const mod = await import("./route.js");
  POST = mod.POST;
});

afterEach(() => {
  vi.clearAllMocks();
});

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    sending_domain: "outbound.acme.com",
    original_sequence: "Subject: hi\nHey {{first_name}}",
    icp_paragraph: "Series A SaaS",
    sample_target_companies: ["linear.app"],
    calendar_url: "https://cal.example.com/u",
    brand_voice_url: "https://acme.com",
    ...overrides,
  };
}

function postJson(body: unknown): Request {
  return new Request("http://test/api/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/onboarding", () => {
  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://test/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("returns 400 when required fields are missing (zod schema)", async () => {
    const res = await POST(postJson({ sending_domain: "x.com" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when customer_id is not a UUID", async () => {
    const res = await POST(postJson(validBody({ customer_id: "not-a-uuid" })));
    expect(res.status).toBe(400);
    // zod's uuid() error makes it into the error string.
    const body = await res.json();
    expect(String(body.error).toLowerCase()).toContain("uuid");
  });

  it("uses customer_id directly without a DB fallback lookup", async () => {
    insertSingleMock.mockResolvedValueOnce({ data: { id: "seq1" }, error: null });
    const res = await POST(postJson(validBody({ customer_id: VALID_UUID })));
    expect(res.status).toBe(200);
    expect(customerLookupMaybeSingleMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, customer_id: VALID_UUID, sequence_id: "seq1" });
    expect(inngestSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "onboarding/completed",
        data: { customer_id: VALID_UUID, sequence_id: "seq1" },
      }),
    );
  });

  it("customer_id beats stripe_session_id when both are sent (no DB fallback)", async () => {
    insertSingleMock.mockResolvedValueOnce({ data: { id: "seq2" }, error: null });
    const res = await POST(
      postJson(
        validBody({
          customer_id: VALID_UUID,
          stripe_session_id: "cs_test_abc123",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(customerLookupMaybeSingleMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.customer_id).toBe(VALID_UUID);
  });

  it("falls back to the most-recent onboarding row when only stripe_session_id is provided", async () => {
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: { id: "fallback-id" } });
    insertSingleMock.mockResolvedValueOnce({ data: { id: "seq3" }, error: null });
    const res = await POST(postJson(validBody({ stripe_session_id: "cs_test_abc123" })));
    expect(res.status).toBe(200);
    expect(customerLookupMaybeSingleMock).toHaveBeenCalled();
    const body = await res.json();
    expect(body.customer_id).toBe("fallback-id");
  });

  it("returns 400 when neither customer_id nor a fallback row exists", async () => {
    customerLookupMaybeSingleMock.mockResolvedValueOnce({ data: null });
    const res = await POST(postJson(validBody({ stripe_session_id: "cs_test_abc123" })));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Customer not found. Did checkout complete?",
    });
  });

  it("returns 400 when reviewOnboardingPayload rejects", async () => {
    reviewMock.mockReturnValueOnce({ ok: false, issues: ["bad icp"], suggestions: ["try again"] });
    const res = await POST(postJson(validBody({ customer_id: VALID_UUID })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "bad icp", suggestions: ["try again"] });
  });

  it("returns 500 when the sequence insert errors", async () => {
    insertSingleMock.mockResolvedValueOnce({ data: null, error: new Error("insert failed") });
    const res = await POST(postJson(validBody({ customer_id: VALID_UUID })));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "DB error persisting sequence" });
  });

  it("calls the safe variant with the funnel payload (wiring)", async () => {
    insertSingleMock.mockResolvedValueOnce({ data: { id: "seq-safe" }, error: null });
    const res = await POST(postJson(validBody({ customer_id: VALID_UUID })));
    expect(res.status).toBe(200);
    expect(captureServerEventSafeMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventSafeMock).toHaveBeenCalledWith(
      VALID_UUID,
      "onboarding_completed",
      { customer_id: VALID_UUID },
    );
  });

  it("still returns 200 when funnel emission rejects (escaped safe wrapper)", async () => {
    insertSingleMock.mockResolvedValueOnce({ data: { id: "seq-resilient" }, error: null });
    // Simulates the worst case where captureServerEventSafe's internal
    // try/catch was somehow bypassed (e.g., Sentry itself throwing) and the
    // promise rejects. The route must still return 200 because the
    // success-defining work (sequence insert + inngest dispatch) is done.
    captureServerEventSafeMock.mockRejectedValueOnce(new Error("posthog 503"));
    const res = await POST(postJson(validBody({ customer_id: VALID_UUID })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, customer_id: VALID_UUID, sequence_id: "seq-resilient" });
    // The route's defense-in-depth wrapper reports the funnel failure.
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "onboarding_funnel_emission" }),
    );
  });

  it("still returns 200 when funnel emission AND captureException both throw (total observability failure)", async () => {
    insertSingleMock.mockResolvedValueOnce({ data: { id: "seq-bulletproof" }, error: null });
    captureServerEventSafeMock.mockRejectedValueOnce(new Error("posthog 503"));
    // Future-regression guard: if captureException ever stops being bulletproof
    // and throws synchronously, the route must still return the customer's
    // 200. Mirrors the same case in /api/roast tests.
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error("captureException primitive broke");
    });
    const res = await POST(postJson(validBody({ customer_id: VALID_UUID })));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      customer_id: VALID_UUID,
      sequence_id: "seq-bulletproof",
    });
    // Success-defining work still happened.
    expect(insertSingleMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });
});
