import { z } from "zod";

/**
 * Performance Monitor — daily cron that pulls Smartlead metrics, attributes
 * them to a customer campaign, and computes uplift vs. baseline.
 *
 * This module is intentionally pure (no LLM call) — the heuristics are
 * deterministic and verifiable. The 21-day milestone check returns a flag
 * the Inngest function uses to enqueue a free rewrite if uplift target missed.
 */

export const PerformanceInput = z.object({
  campaign_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  baseline_reply_rate: z.number().min(0).max(1).nullable(),
  metrics_today: z.object({
    sent: z.number().int().min(0),
    opens: z.number().int().min(0),
    replies: z.number().int().min(0),
    meetings_booked: z.number().int().min(0),
  }),
  days_since_start: z.number().int().min(0),
  uplift_target_pct: z.number().default(10),
});
export type PerformanceInputT = z.infer<typeof PerformanceInput>;

export const PerformanceSnapshot = z.object({
  customer_id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  current_reply_rate: z.number(),
  uplift_pct: z.number().nullable(),
  trigger_21_day_milestone: z.boolean(),
  trigger_free_rewrite: z.boolean(),
  alerts: z.array(z.string()),
});
export type PerformanceSnapshotT = z.infer<typeof PerformanceSnapshot>;

export function computePerformance(input: PerformanceInputT): PerformanceSnapshotT {
  const { sent, opens, replies } = input.metrics_today;
  const alerts: string[] = [];

  const replyRate = sent > 0 ? replies / sent : 0;
  const openRate = sent > 0 ? opens / sent : 0;

  let upliftPct: number | null = null;
  if (input.baseline_reply_rate != null && input.baseline_reply_rate > 0) {
    upliftPct = ((replyRate - input.baseline_reply_rate) / input.baseline_reply_rate) * 100;
  }

  // Deliverability alerts
  if (sent > 50 && openRate < 0.05) {
    alerts.push(`Open rate ${(openRate * 100).toFixed(1)}% is below 5% on ${sent} sends — deliverability risk.`);
  }
  if (sent > 100 && replyRate === 0) {
    alerts.push(`Zero replies on ${sent} sends — copy or audience problem.`);
  }

  // 21-day milestone — PRD §4.2 step 6
  const isMilestone = input.days_since_start >= 21 && input.days_since_start <= 23;
  const triggerFreeRewrite = isMilestone && (upliftPct == null || upliftPct < input.uplift_target_pct);

  if (triggerFreeRewrite) {
    alerts.push(
      `21-day milestone: uplift ${upliftPct?.toFixed(1) ?? "n/a"}% < target ${input.uplift_target_pct}% — trigger free rewrite.`,
    );
  }

  return {
    customer_id: input.customer_id,
    campaign_id: input.campaign_id,
    current_reply_rate: Number(replyRate.toFixed(4)),
    uplift_pct: upliftPct == null ? null : Number(upliftPct.toFixed(2)),
    trigger_21_day_milestone: isMilestone,
    trigger_free_rewrite: triggerFreeRewrite,
    alerts,
  };
}
