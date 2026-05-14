import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { smartlead, performance } from "@copywriting-bot/agents";
import { emitFunnelEvent, type FunnelStep } from "./_funnel.js";
import { listActiveCampaignsPaginated, type ActiveCampaign } from "./_campaigns.js";

export type PerformancePullCtx = {
  step: FunnelStep & {
    sendEvent: (id: string, payload: { name: string; data: object }) => Promise<unknown>;
  };
};

/**
 * performanceDailyPull — scheduled daily; pulls Smartlead metrics for every
 * active campaign, persists a performance_snapshot row, and triggers the
 * 21-day milestone if uplift target missed (PRD §4.2 step 6, §6.1).
 */
export async function runPerformanceDailyPull({ step }: PerformancePullCtx) {
  const db = serviceClient();

  const campaigns: ActiveCampaign[] = await step.run("list-active-campaigns", () =>
    listActiveCampaignsPaginated(db),
  );

  const today = new Date().toISOString().slice(0, 10);
  const results: Array<{ campaign_id: string; snapshot_date: string; trigger_free_rewrite: boolean }> = [];

  for (const camp of campaigns) {
    if (!camp || !camp.smartlead_campaign_id) continue;
    const slCampaignId = Number.parseInt(camp.smartlead_campaign_id, 10);
    if (Number.isNaN(slCampaignId)) continue;

    const metrics = await step.run(`pull-metrics-${camp.id}`, async () => {
      return smartlead.getCampaignMetrics(slCampaignId);
    });

    const snap = await step.run(`compute-${camp.id}`, async () => {
      const days = camp.started_at
        ? Math.floor((Date.now() - new Date(camp.started_at).getTime()) / 86_400_000)
        : 0;
      return performance.computePerformance({
        campaign_id: camp.id,
        customer_id: camp.customer_id,
        baseline_reply_rate: null,
        metrics_today: {
          sent: metrics.sent,
          opens: metrics.unique_opens,
          replies: metrics.replies,
          meetings_booked: 0,
        },
        days_since_start: days,
        uplift_target_pct: 10,
      });
    });

    await step.run(`persist-${camp.id}`, async () => {
      const { error } = await db.from("performance_snapshots").upsert(
        {
          customer_id: snap.customer_id,
          campaign_id: snap.campaign_id,
          snapshot_date: today,
          opens: metrics.unique_opens,
          replies: metrics.replies,
          meetings_booked: 0,
          current_reply_rate: snap.current_reply_rate,
          uplift_pct: snap.uplift_pct,
        },
        { onConflict: "campaign_id,snapshot_date" },
      );
      // Surface upsert failures so Inngest retries; a silent swallow would
      // hide stale-snapshot bugs from operators.
      if (error) throw error;
    });

    await emitFunnelEvent(
      step,
      `emit-perf-report-funnel-${camp.id}`,
      snap.customer_id,
      "performance_report_sent",
      {
        campaign_id: snap.campaign_id,
        snapshot_date: today,
        current_reply_rate: snap.current_reply_rate,
        uplift_pct: snap.uplift_pct,
      },
    );

    if (snap.trigger_free_rewrite) {
      await step.sendEvent(`free-rewrite-${camp.id}`, {
        name: "rewrite/requested",
        data: { customer_id: snap.customer_id, sequence_id: "" },
      });
    }

    results.push({ campaign_id: camp.id, snapshot_date: today, trigger_free_rewrite: snap.trigger_free_rewrite });
  }

  return { processed: results.length, results };
}

export const performanceDailyPull = inngest.createFunction(
  { id: "performance-daily-pull", name: "Performance daily pull" },
  { cron: "TZ=UTC 30 6 * * *" },
  async ({ step }) => runPerformanceDailyPull({ step: step as PerformancePullCtx["step"] }),
);
