import { serverEnv } from "@copywriting-bot/shared/env";

/**
 * Thin HTTP client over the Smartlead REST API.
 *
 * We only wrap the endpoints we actually use in MVP. Callers should funnel
 * everything through here so the API key never leaks into agent code and so
 * we can swap to a self-hosted SES sender in Phase 2 without touching agents.
 */

type FetchInit = Omit<RequestInit, "body"> & { body?: unknown };

async function call<T>(path: string, init: FetchInit = {}): Promise<T> {
  const env = serverEnv();
  if (!env.SMARTLEAD_API_KEY) {
    throw new Error("SMARTLEAD_API_KEY is not configured");
  }
  const url = `${env.SMARTLEAD_BASE_URL}${path}${path.includes("?") ? "&" : "?"}api_key=${env.SMARTLEAD_API_KEY}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Smartlead ${path} returned ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export type SmartleadCampaign = { id: number; name: string; status: string };

export async function createCampaign(name: string): Promise<SmartleadCampaign> {
  return call<SmartleadCampaign>("/campaigns/create", {
    method: "POST",
    body: { name },
  });
}

export async function setCampaignSchedule(
  campaignId: number,
  schedule: {
    timezone: string;
    days_of_week: number[]; // 1=Mon, 7=Sun
    start_hour: string; // "09:00"
    end_hour: string; // "17:00"
    min_time_btw_emails: number; // seconds
    max_new_leads_per_day: number;
  },
): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>(`/campaigns/${campaignId}/schedule`, {
    method: "POST",
    body: schedule,
  });
}

export async function uploadLeads(
  campaignId: number,
  leads: Array<{
    email: string;
    first_name?: string;
    last_name?: string;
    company_name?: string;
    custom_fields?: Record<string, string>;
  }>,
): Promise<{ inserted: number; skipped: number }> {
  return call<{ inserted: number; skipped: number }>(
    `/campaigns/${campaignId}/leads`,
    { method: "POST", body: { lead_list: leads } },
  );
}

export async function startCampaign(campaignId: number): Promise<{ status: string }> {
  return call<{ status: string }>(`/campaigns/${campaignId}/status`, {
    method: "POST",
    body: { status: "START" },
  });
}

export async function pauseCampaign(campaignId: number): Promise<{ status: string }> {
  return call<{ status: string }>(`/campaigns/${campaignId}/status`, {
    method: "POST",
    body: { status: "PAUSED" },
  });
}

export type CampaignMetrics = {
  campaign_id: number;
  sent: number;
  opens: number;
  unique_opens: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
};

export async function getCampaignMetrics(campaignId: number): Promise<CampaignMetrics> {
  return call<CampaignMetrics>(`/campaigns/${campaignId}/statistics`);
}
