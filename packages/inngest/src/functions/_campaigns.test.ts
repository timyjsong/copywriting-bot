import { describe, expect, it } from "vitest";
import {
  ACTIVE_CAMPAIGN_PAGE_SIZE,
  listActiveCampaignsPaginated,
  type ActiveCampaign,
} from "./_campaigns.js";
import { makeSupabaseFake } from "../test-utils/supabase-fake.js";

/**
 * Direct unit tests for `listActiveCampaignsPaginated`. The integration
 * suites only exercise the default `pageSize=200`; these tests pin the
 * pagination contract (terminator condition, custom page size, DB-error
 * propagation) at the helper boundary.
 */
describe("listActiveCampaignsPaginated", () => {
  function row(id: string): ActiveCampaign {
    return {
      id,
      customer_id: `cust-${id}`,
      smartlead_campaign_id: `sl-${id}`,
      started_at: "2026-04-01T00:00:00Z",
    };
  }

  it("ACTIVE_CAMPAIGN_PAGE_SIZE matches the documented production chunk size", () => {
    expect(ACTIVE_CAMPAIGN_PAGE_SIZE).toBe(200);
  });

  it("returns [] and makes exactly one range call when the first page is empty", async () => {
    const fake = makeSupabaseFake({
      campaigns: { pages: { pageSize: 200, pages: [[]] } },
    });

    const out = await listActiveCampaignsPaginated(fake.db);

    expect(out).toEqual([]);
    expect(fake.recorded.rangeCalls.campaigns).toEqual([[0, 199]]);
  });

  it("returns all rows from a single short page (< pageSize) without a second range call", async () => {
    const page = [row("a"), row("b"), row("c")];
    const fake = makeSupabaseFake({
      campaigns: { pages: { pageSize: 200, pages: [page] } },
    });

    const out = await listActiveCampaignsPaginated(fake.db);

    expect(out).toEqual(page);
    expect(fake.recorded.rangeCalls.campaigns).toEqual([[0, 199]]);
  });

  it("paginates across an exact-fill boundary (pageSize rows then 0 rows)", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => row(String(i)));
    const fake = makeSupabaseFake({
      campaigns: { pages: { pageSize: 200, pages: [page1, []] } },
    });

    const out = await listActiveCampaignsPaginated(fake.db);

    expect(out).toHaveLength(200);
    expect(out[0]!.id).toBe("0");
    expect(out[199]!.id).toBe("199");
    expect(fake.recorded.rangeCalls.campaigns).toEqual([
      [0, 199],
      [200, 399],
    ]);
  });

  it("honours a custom pageSize parameter end-to-end", async () => {
    // Page-size=1 walks one row at a time and terminates on the first
    // short page. Locks the `from += pageSize` advance against any
    // future off-by-one regression.
    const fake = makeSupabaseFake({
      campaigns: {
        pages: { pageSize: 1, pages: [[row("a")], [row("b")], []] },
      },
    });

    const out = await listActiveCampaignsPaginated(fake.db, 1);

    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(fake.recorded.rangeCalls.campaigns).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("propagates the DB error untouched (so Inngest retries the step)", async () => {
    // The fake's `.range()` path doesn't model errors; build a minimal
    // ad-hoc port that returns `{data:null,error:...}` to lock the throw.
    const dbErr = new Error("Postgres unreachable");
    const fakeDb = {
      from: () => ({
        select: () => ({
          in: () => ({
            order: () => ({
              range: () =>
                Promise.resolve({ data: null, error: dbErr }) as unknown as Promise<{
                  data: ActiveCampaign[] | null;
                  error: Error | null;
                }>,
            }),
          }),
        }),
      }),
    } as never;

    await expect(listActiveCampaignsPaginated(fakeDb)).rejects.toThrow(/Postgres unreachable/);
  });
});
