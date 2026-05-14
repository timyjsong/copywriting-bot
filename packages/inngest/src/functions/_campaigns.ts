import { serviceClient } from "@copywriting-bot/db/client";

type DbClient = ReturnType<typeof serviceClient>;

export type ActiveCampaign = {
  id: string;
  customer_id: string;
  smartlead_campaign_id: string | null;
  started_at: string | null;
};

// Chunk size for paginating list-active-campaigns. Caps single-function memory
// and gives Inngest a natural per-step boundary; tune as customer count grows.
export const ACTIVE_CAMPAIGN_PAGE_SIZE = 200;

/**
 * Paginate the `campaigns` table for rows in warmup/sending status. Stops
 * when a short page (< pageSize) is returned. Stable ordered by `id` so
 * pages are deterministic across retries. The empty-next-page case (exactly
 * a full page followed by zero rows) is exercised by tests.
 */
export async function listActiveCampaignsPaginated(
  db: DbClient,
  pageSize: number = ACTIVE_CAMPAIGN_PAGE_SIZE,
): Promise<ActiveCampaign[]> {
  const collected: ActiveCampaign[] = [];
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await db
      .from("campaigns")
      .select("id, customer_id, smartlead_campaign_id, started_at")
      .in("status", ["warmup", "sending"])
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    const page = (data ?? []) as ActiveCampaign[];
    collected.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return collected;
}
