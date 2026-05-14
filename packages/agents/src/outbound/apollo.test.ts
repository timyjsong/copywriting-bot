if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = "test-supabase-key";
if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
if (!process.env.STRIPE_WEBHOOK_SECRET) process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEnvForTests } from "@copywriting-bot/shared/env";
import { searchProspects } from "./apollo.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetEnvForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  __resetEnvForTests();
  delete process.env.APOLLO_API_KEY;
});

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return impl(url, init);
  }) as unknown as typeof fetch;
}

describe("searchProspects", () => {
  it("throws when APOLLO_API_KEY is missing", async () => {
    delete process.env.APOLLO_API_KEY;
    await expect(searchProspects({})).rejects.toThrow(/APOLLO_API_KEY/);
  });

  it("sends a POST to the Apollo endpoint with default titles + employee range", async () => {
    process.env.APOLLO_API_KEY = "ak_test";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ people: [], pagination: { total_entries: 0 } }),
        { status: 200 },
      );
    });

    const out = await searchProspects({});
    expect(capturedUrl).toBe("https://api.apollo.io/api/v1/mixed_people/search");
    expect(capturedInit?.method).toBe("POST");
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.api_key).toBe("ak_test");
    expect(body.person_titles).toEqual(["Founder", "Co-Founder", "Head of Growth"]);
    expect(body.organization_num_employees_ranges).toEqual(["10,500"]);
    expect(body.per_page).toBe(25);
    expect(out.total).toBe(0);
    expect(out.prospects).toEqual([]);
  });

  it("maps Apollo people into ApolloProspect shape and drops those without organization", async () => {
    process.env.APOLLO_API_KEY = "ak_test";
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          people: [
            {
              id: "1",
              first_name: "Jane",
              last_name: "Roe",
              title: "Founder",
              email: "jane@example.com",
              organization: {
                name: "Foo SaaS",
                primary_domain: "foo.example",
                estimated_num_employees: 42,
                industry: "Software",
              },
            },
            // Should be filtered out — no organization
            {
              id: "2",
              first_name: "Solo",
              last_name: "Operator",
              title: "Founder",
              email: null,
              organization: null,
            },
          ],
          pagination: { total_entries: 2 },
        }),
        { status: 200 },
      ),
    );

    const out = await searchProspects({});
    expect(out.total).toBe(2);
    expect(out.prospects).toHaveLength(1);
    expect(out.prospects[0]).toEqual({
      id: "1",
      first_name: "Jane",
      last_name: "Roe",
      title: "Founder",
      email: "jane@example.com",
      organization: {
        name: "Foo SaaS",
        primary_domain: "foo.example",
        estimated_num_employees: 42,
        industry: "Software",
      },
    });
  });

  it("passes through custom titles + employee range", async () => {
    process.env.APOLLO_API_KEY = "ak_test";
    let capturedBody: Record<string, unknown> = {};
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ people: [] }), { status: 200 });
    });

    await searchProspects({
      titles: ["CEO"],
      employee_min: 50,
      employee_max: 200,
      page: 3,
      per_page: 10,
    });

    expect(capturedBody.person_titles).toEqual(["CEO"]);
    expect(capturedBody.organization_num_employees_ranges).toEqual(["50,200"]);
    expect(capturedBody.page).toBe(3);
    expect(capturedBody.per_page).toBe(10);
  });

  it("throws including status code and body preview when Apollo returns non-2xx", async () => {
    process.env.APOLLO_API_KEY = "ak_test";
    mockFetch(async () => new Response("rate limited; slow down", { status: 429 }));
    await expect(searchProspects({})).rejects.toThrow(/429/);
    await expect(searchProspects({})).rejects.toThrow(/rate limited/);
  });

  it("falls back to people.length when pagination is absent", async () => {
    process.env.APOLLO_API_KEY = "ak_test";
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          people: [
            {
              id: "1",
              first_name: "a",
              last_name: "b",
              title: "x",
              email: null,
              organization: { name: "co", primary_domain: null, estimated_num_employees: null, industry: null },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const out = await searchProspects({});
    expect(out.total).toBe(1);
  });
});
