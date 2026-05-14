import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoastRequest } from "@copywriting-bot/shared/schemas";

/**
 * Two layers of coverage for /api/roast:
 *
 * 1) Schema contract — the request payload the UI sends must parse cleanly
 *    and pathological inputs must reject.
 * 2) Handler-level wiring — the route must call the *safe* funnel-emission
 *    variant (not the unsafe one) and must still return success to the user
 *    when PostHog rejects. A future revert from `captureServerEventSafe`
 *    back to `captureServerEvent` (or wrapping in a way that propagates) would
 *    break the contract; these tests catch it.
 */

describe("RoastRequest validation", () => {
  it("accepts a typical paste", () => {
    const out = RoastRequest.safeParse({
      email: "user@example.com",
      sequence: "Subject: hi\n\nHey {{first_name}}, saw you launched X. Could we trade notes? — Alex",
      source: "web",
    });
    expect(out.success).toBe(true);
  });

  it("rejects too-short sequences", () => {
    const out = RoastRequest.safeParse({ email: "user@example.com", sequence: "too short" });
    expect(out.success).toBe(false);
  });

  it("rejects invalid emails", () => {
    const out = RoastRequest.safeParse({
      email: "not-an-email",
      sequence: "Subject: hi\n\nHey there, this is at least forty characters long for the validator.",
    });
    expect(out.success).toBe(false);
  });

  it("rejects pastes over 20k characters", () => {
    const out = RoastRequest.safeParse({
      email: "user@example.com",
      sequence: "x".repeat(20_001),
    });
    expect(out.success).toBe(false);
  });
});

// --- Handler-level tests ---------------------------------------------------

const runRoastAgentMock = vi.fn();
const insertSingleMock = vi.fn();
const insertPayloadMock = vi.fn();
const fromTableMock = vi.fn();
const inngestSendMock = vi.fn();
const captureServerEventSafeMock = vi.fn();
const captureServerEventUnsafeMock = vi.fn();
const captureExceptionMock = vi.fn();

vi.mock("@copywriting-bot/agents/roast", () => ({
  runRoastAgent: (...args: unknown[]) => runRoastAgentMock(...args),
}));

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: () => ({
    // Capture the table name + insert payload so a regression that inserts
    // into the wrong table (e.g., `sequences` instead of `roasts`) or drops a
    // column is caught at the assertion layer, not silently passed.
    from: (table: string) => {
      fromTableMock(table);
      return {
        insert: (payload: unknown) => {
          insertPayloadMock(payload);
          return { select: () => ({ single: insertSingleMock }) };
        },
      };
    },
  }),
}));

vi.mock("@copywriting-bot/inngest/client", () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureException: captureExceptionMock,
  captureServerEvent: captureServerEventUnsafeMock,
  captureServerEventSafe: captureServerEventSafeMock,
}));

type RouteModule = typeof import("./route.js");
let POST: RouteModule["POST"];

const VALID_BODY = {
  email: "user@example.com",
  sequence: "Subject: hi\n\nHey {{first_name}}, saw you launched X. Could we trade notes? — Alex",
  source: "web",
};

const AGENT_OK = {
  ok: true as const,
  result: {
    overall_score: 42,
    is_real_cold_email: true,
    dimensions: {},
    worst_email_rewrite: null,
    sharable_badge_payload: { score: 42, tier: "C" },
  },
};

beforeEach(async () => {
  vi.resetModules();
  runRoastAgentMock.mockReset();
  insertSingleMock.mockReset();
  insertPayloadMock.mockReset();
  fromTableMock.mockReset();
  inngestSendMock.mockReset();
  captureServerEventSafeMock.mockReset();
  captureServerEventUnsafeMock.mockReset();
  captureExceptionMock.mockReset();
  runRoastAgentMock.mockResolvedValue(AGENT_OK);
  insertSingleMock.mockResolvedValue({ data: { id: "roast-1" }, error: null });
  inngestSendMock.mockResolvedValue({});
  captureServerEventSafeMock.mockResolvedValue(undefined);
  const mod = await import("./route.js");
  POST = mod.POST;
});

afterEach(() => {
  vi.clearAllMocks();
});

function postJson(body: unknown): Request {
  return new Request("http://test/api/roast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/roast handler", () => {
  it("returns 200 with the full roast result + roast_id on the happy path", async () => {
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Lock in the whole response shape — a regression that drops `result` or
    // the badge payload would silently break the share-image flow downstream.
    expect(body).toEqual({
      roast_id: "roast-1",
      result: AGENT_OK.result,
    });
  });

  it("persists into the `roasts` table with the expected columns", async () => {
    await POST(postJson(VALID_BODY));
    expect(fromTableMock).toHaveBeenCalledWith("roasts");
    expect(insertPayloadMock).toHaveBeenCalledTimes(1);
    expect(insertPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        source: "web",
        input_text: VALID_BODY.sequence,
        overall_score: AGENT_OK.result.overall_score,
        is_real_cold_email: AGENT_OK.result.is_real_cold_email,
        result_json: AGENT_OK.result,
      }),
    );
  });

  it("dispatches `roast/submitted` to Inngest with the new roast_id", async () => {
    await POST(postJson(VALID_BODY));
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledWith({
      name: "roast/submitted",
      data: { roast_id: "roast-1", email: "user@example.com", source: "web" },
    });
  });

  it("calls the safe funnel variant (NOT the unsafe one) with the submitted_email event", async () => {
    await POST(postJson(VALID_BODY));
    expect(captureServerEventSafeMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventSafeMock).toHaveBeenCalledWith(
      "user@example.com",
      "submitted_email",
      { source: "web" },
    );
    // Defense against a regression that re-introduces the throw-propagating
    // variant on this hot path.
    expect(captureServerEventUnsafeMock).not.toHaveBeenCalled();
  });

  it("still returns 200 when funnel emission rejects (escaped safe wrapper)", async () => {
    captureServerEventSafeMock.mockRejectedValueOnce(new Error("posthog 503"));
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ roast_id: "roast-1" });
    // Roast was still generated and persisted despite the funnel failure.
    expect(runRoastAgentMock).toHaveBeenCalledTimes(1);
    expect(insertSingleMock).toHaveBeenCalledTimes(1);
    // The route's defense-in-depth wrapper reports the error to Sentry.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "roast_funnel_emission" }),
    );
  });

  it("still returns 200 when funnel emission AND captureException both throw (total observability failure)", async () => {
    // Defense-in-depth: the route's catch handler calls captureException, but
    // if that primitive itself throws (e.g., future regression), the user must
    // still get their roast. Mirrors safe-capture.test.ts last-resort cases.
    captureServerEventSafeMock.mockRejectedValueOnce(new Error("posthog 503"));
    captureExceptionMock.mockImplementationOnce(() => {
      throw new Error("captureException primitive broke");
    });
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ roast_id: "roast-1" });
    expect(insertSingleMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it("returns 502 when runRoastAgent fails (non-ok outcome)", async () => {
    runRoastAgentMock.mockResolvedValueOnce({
      ok: false as const,
      status: 502,
      error: "Anthropic 503",
    });
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "Anthropic 503" });
    // No DB write, no Inngest dispatch when the agent itself failed.
    expect(insertSingleMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the DB insert errors and does NOT dispatch Inngest", async () => {
    insertSingleMock.mockResolvedValueOnce({
      data: null,
      error: new Error("constraint violation"),
    });
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: "Roast generated but could not be persisted. Try again.",
    });
    // Critical: Inngest must NOT receive an event referencing a row that
    // doesn't exist, or downstream consumers blow up.
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});
