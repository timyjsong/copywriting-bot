// Test-time env defaults — must be set before importing modules that read env.
// Use straight assignment (not `??=`) because a .env loader may have set these
// to "" which is not nullish but still fails zod's min(1).
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = "test-supabase-key";
if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
if (!process.env.STRIPE_WEBHOOK_SECRET) process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as smartlead from "./smartlead.js";
import { __resetEnvForTests } from "@copywriting-bot/shared/env";

/**
 * Smartlead client tests.
 *
 * We don't want to hit the real API in tests; we replace `globalThis.fetch`
 * with a recording mock so we can assert (a) URLs are built correctly,
 * (b) the API key is appended, (c) non-2xx responses throw with the body
 * preview included.
 */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetEnvForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  __resetEnvForTests();
});

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return impl(url, init);
  }) as unknown as typeof fetch;
}

describe("smartlead client", () => {
  it("throws a helpful error when SMARTLEAD_API_KEY is missing", async () => {
    delete process.env.SMARTLEAD_API_KEY;
    await expect(smartlead.createCampaign("test")).rejects.toThrow(/SMARTLEAD_API_KEY/);
  });

  it("appends api_key on a path without existing query params", async () => {
    process.env.SMARTLEAD_API_KEY = "test-key";
    process.env.SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";
    const seen: string[] = [];
    mockFetch(async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ id: 7, name: "demo", status: "DRAFTED" }), { status: 200 });
    });

    const out = await smartlead.createCampaign("demo");
    expect(out).toEqual({ id: 7, name: "demo", status: "DRAFTED" });
    expect(seen[0]).toContain("/campaigns/create?api_key=test-key");
  });

  it("throws when Smartlead returns non-2xx, including a status + body slice", async () => {
    process.env.SMARTLEAD_API_KEY = "k";
    process.env.SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";
    mockFetch(async () => new Response("boom: rate limited", { status: 429 }));
    await expect(smartlead.getCampaignMetrics(1)).rejects.toThrow(/429/);
    await expect(smartlead.getCampaignMetrics(1)).rejects.toThrow(/boom/);
  });

  it("serialises body as JSON and sets Content-Type", async () => {
    process.env.SMARTLEAD_API_KEY = "k";
    process.env.SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";
    let capturedInit: RequestInit | undefined;
    mockFetch(async (_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ inserted: 2, skipped: 0 }), { status: 200 });
    });

    await smartlead.uploadLeads(7, [{ email: "a@b.co" }, { email: "c@d.co" }]);
    const headers = new Headers(capturedInit?.headers ?? {});
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = capturedInit?.body ?? null;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({
      lead_list: [{ email: "a@b.co" }, { email: "c@d.co" }],
    });
  });
});
