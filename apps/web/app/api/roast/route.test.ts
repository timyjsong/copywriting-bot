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
const inngestSendMock = vi.fn();
const captureServerEventSafeMock = vi.fn();
const captureServerEventUnsafeMock = vi.fn();

vi.mock("@copywriting-bot/agents/roast", () => ({
  runRoastAgent: (...args: unknown[]) => runRoastAgentMock(...args),
}));

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: () => ({
    from: () => ({
      insert: () => ({
        select: () => ({ single: insertSingleMock }),
      }),
    }),
  }),
}));

vi.mock("@copywriting-bot/inngest/client", () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureException: vi.fn(),
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
  inngestSendMock.mockReset();
  captureServerEventSafeMock.mockReset();
  captureServerEventUnsafeMock.mockReset();
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
  it("returns 200 with the roast result on the happy path", async () => {
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ roast_id: "roast-1" });
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
  });
});
