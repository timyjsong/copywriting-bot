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
const emitFunnelEventBestEffortMock = vi.fn();
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
  emitFunnelEventBestEffort: emitFunnelEventBestEffortMock,
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
  emitFunnelEventBestEffortMock.mockReset();
  captureServerEventSafeMock.mockReset();
  captureServerEventUnsafeMock.mockReset();
  captureExceptionMock.mockReset();
  runRoastAgentMock.mockResolvedValue(AGENT_OK);
  insertSingleMock.mockResolvedValue({ data: { id: "roast-1" }, error: null });
  inngestSendMock.mockResolvedValue({});
  emitFunnelEventBestEffortMock.mockResolvedValue(undefined);
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

  it("persists into the `roasts` table with EXACTLY the expected column set (no leakage)", async () => {
    await POST(postJson(VALID_BODY));
    expect(fromTableMock).toHaveBeenCalledWith("roasts");
    expect(insertPayloadMock).toHaveBeenCalledTimes(1);
    expect(insertPayloadMock).toHaveBeenCalledWith({
      email: "user@example.com",
      source: "web",
      input_text: VALID_BODY.sequence,
      overall_score: AGENT_OK.result.overall_score,
      is_real_cold_email: AGENT_OK.result.is_real_cold_email,
      result_json: AGENT_OK.result,
    });
    // Hard-pin the key set so a regression that adds raw IP, full headers, or
    // any other field to the insert payload fails loudly. iter-17 flagged the
    // prior `objectContaining` assertion as silently permissive.
    const firstCall = insertPayloadMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const payload = firstCall![0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["email", "input_text", "is_real_cold_email", "overall_score", "result_json", "source"],
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

  it("calls emitFunnelEventBestEffort (NOT the raw safe/unsafe variants) with submitted_email + the funnel phase tag", async () => {
    await POST(postJson(VALID_BODY));
    expect(emitFunnelEventBestEffortMock).toHaveBeenCalledTimes(1);
    expect(emitFunnelEventBestEffortMock).toHaveBeenCalledWith(
      "user@example.com",
      "submitted_email",
      { source: "web" },
      { phase: "roast_funnel_emission" },
    );
    // Defense against a regression that bypasses the primitive and calls
    // captureServerEvent(Safe) directly — that would re-introduce the
    // duplicated DiD block iter 18 collapsed.
    expect(captureServerEventSafeMock).not.toHaveBeenCalled();
    expect(captureServerEventUnsafeMock).not.toHaveBeenCalled();
  });

  it("propagates if the funnel primitive itself throws — primitive owns the never-throw contract; pins ordering: emit-before-work", async () => {
    // Contract: emitFunnelEventBestEffort is documented to never throw
    // (verified in safe-capture.test.ts). The route deliberately has no
    // local try/catch around it — the primitive owns the contract. If a
    // future change ever lets a throw escape, the route WILL 500 the user.
    // This test pins both that propagation behavior AND the call-ordering
    // (emit-before-work) so any regression is visible.
    emitFunnelEventBestEffortMock.mockRejectedValueOnce(new Error("primitive broke"));
    await expect(POST(postJson(VALID_BODY))).rejects.toThrow("primitive broke");
    // Ordering pin: agent + DB never ran, since the funnel emit happens
    // first. A future ordering swap (emit-after-success) would let these
    // run before the throw — pin against that.
    expect(runRoastAgentMock).not.toHaveBeenCalled();
    expect(insertSingleMock).not.toHaveBeenCalled();
  });

  it("returns 502 + reports to Sentry when runRoastAgent THROWS (vs the non-ok outcome path)", async () => {
    // Iter-17 review surfaced this gap: only the `{ ok: false }` outcome was
    // covered. If the agent rejects (SDK bug, network error outside its retry
    // budget), the route must catch + report + 502, not unhandled-500 the user.
    runRoastAgentMock.mockRejectedValueOnce(new Error("anthropic SDK threw"));
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "Roast service unavailable" });
    // Persistence must NOT run if the agent itself blew up.
    expect(insertSingleMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
    // Sentry breadcrumb is the only record of why this 502'd.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "roast_agent_invoke" }),
    );
  });

  it("still returns 200 + reports when inngest.send REJECTS post-persistence", async () => {
    // The roast row is already inserted, so the user's roast_id is valid. A
    // queue blip must not 500 them — a reconciliation cron can re-fire the
    // event later. Iter-17 review flagged this contract was unspecified.
    inngestSendMock.mockRejectedValueOnce(new Error("inngest 503"));
    const res = await POST(postJson(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ roast_id: "roast-1", result: AGENT_OK.result });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "roast_inngest_dispatch", roast_id: "roast-1" }),
    );
    // Symmetry pin (mirrors the onboarding equivalent): the funnel emit must
    // have already fired before inngest dispatch was attempted. Catches an
    // ordering regression that would skip the emit when inngest blips.
    expect(emitFunnelEventBestEffortMock).toHaveBeenCalledTimes(1);
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
