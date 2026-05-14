import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for /api/dashboard/status. The route has six observable branches:
 * 400 missing/invalid email, 404 customer not found, 500 DB throw, and the
 * 200 success path with each of the three sub-queries either null or present.
 *
 * The three parallel sub-queries (sequence/campaign/snapshot) each go through
 * an `.order().limit().maybeSingle()` chain. We capture sequential calls so a
 * single test can return different values per query.
 */

const customerMaybeSingleMock = vi.fn();
const subQueryQueue: Array<{ data: unknown }> = [];
const captureExceptionMock = vi.fn();

function chain(): any {
  const obj: any = {
    select: () => obj,
    eq: () => obj,
    order: () => obj,
    limit: () => obj,
    maybeSingle: () => {
      const next = subQueryQueue.shift() ?? { data: null };
      return Promise.resolve(next);
    },
  };
  return obj;
}

let throwOnFrom = false;

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (throwOnFrom) throw new Error("db boom");
      if (table === "customers") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: customerMaybeSingleMock }) }),
        };
      }
      return chain();
    },
  }),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureException: captureExceptionMock,
}));

type RouteModule = typeof import("./route.js");
let GET: RouteModule["GET"];

beforeEach(async () => {
  vi.resetModules();
  customerMaybeSingleMock.mockReset();
  captureExceptionMock.mockReset();
  subQueryQueue.length = 0;
  throwOnFrom = false;
  const mod = await import("./route.js");
  GET = mod.GET;
});

afterEach(() => {
  vi.clearAllMocks();
});

function getReq(query: string): Request {
  return new Request(`http://test/api/dashboard/status${query}`);
}

describe("GET /api/dashboard/status", () => {
  it("returns 400 when email query param is missing", async () => {
    const res = await GET(getReq(""));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Email required" });
  });

  it("returns 400 when email is not a valid email", async () => {
    const res = await GET(getReq("?email=not-an-email"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when no customer row matches the email", async () => {
    customerMaybeSingleMock.mockResolvedValueOnce({ data: null });
    const res = await GET(getReq("?email=missing%40example.com"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ found: false });
  });

  it("returns 200 with nulls for all sub-queries when none exist yet", async () => {
    customerMaybeSingleMock.mockResolvedValueOnce({
      data: { id: "c1", email: "u@example.com", status: "onboarding", tier: "full", company_domain: "acme.com", created_at: "2026-01-01" },
    });
    // No sub-results queued: all three sub-queries default to { data: null }.
    const res = await GET(getReq("?email=u%40example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      found: true,
      customer: expect.objectContaining({ id: "c1", email: "u@example.com" }),
      sequence: null,
      campaign: null,
      latest_snapshot: null,
    });
  });

  it("returns 200 with each sub-query value when all are present", async () => {
    customerMaybeSingleMock.mockResolvedValueOnce({
      data: { id: "c1", email: "u@example.com", status: "active", tier: "full", company_domain: "acme.com", created_at: "2026-01-01" },
    });
    subQueryQueue.push(
      { data: { id: "s1", version: 1, status: "approved", created_at: "2026-01-02", approved_at: "2026-01-03" } },
      { data: { id: "cmp1", status: "sending", warmup_status: "complete", daily_cap: 50, started_at: "2026-01-04" } },
      {
        data: {
          snapshot_date: "2026-01-05",
          opens: 100,
          replies: 5,
          meetings_booked: 1,
          baseline_reply_rate: 0.02,
          current_reply_rate: 0.05,
          uplift_pct: 150,
        },
      },
    );
    const res = await GET(getReq("?email=u%40example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sequence).toMatchObject({ id: "s1", status: "approved" });
    expect(body.campaign).toMatchObject({ id: "cmp1", warmup_status: "complete" });
    expect(body.latest_snapshot).toMatchObject({ uplift_pct: 150, replies: 5 });
  });

  it("returns 200 with partial sub-queries (sequence present, campaign + snapshot missing)", async () => {
    customerMaybeSingleMock.mockResolvedValueOnce({
      data: { id: "c1", email: "u@example.com", status: "awaiting_rewrite_approval", tier: "full", company_domain: "acme.com", created_at: "2026-01-01" },
    });
    subQueryQueue.push(
      { data: { id: "s1", version: 1, status: "draft", created_at: "2026-01-02", approved_at: null } },
      { data: null },
      { data: null },
    );
    const res = await GET(getReq("?email=u%40example.com"));
    const body = await res.json();
    expect(body.sequence).toMatchObject({ status: "draft" });
    expect(body.campaign).toBeNull();
    expect(body.latest_snapshot).toBeNull();
  });

  it("returns 500 and captures when the DB client throws", async () => {
    throwOnFrom = true;
    const res = await GET(getReq("?email=u%40example.com"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "Could not load status" });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "dashboard_status" }),
    );
  });
});
