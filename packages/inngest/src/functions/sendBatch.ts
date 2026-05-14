import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { emitFunnelEvent } from "./_funnel.js";
import type { DbPort } from "./_db.js";
import { withOperatorApproval, type ApprovalStep } from "./_approval-gate.js";

/**
 * sendBatchGenerate — when an approved sequence's campaign needs a daily
 * batch, the operator dashboard (or the daily cron, Phase 3+) emits
 * `send_batch/generate`. We materialise a send_batch row with status
 * 'pending_approval' and create an approval queue item.
 *
 * Once the operator approves, the wait resumes and we mark the batch
 * 'approved' so the downstream Smartlead sender can pick it up. Phase 3 will
 * wire the actual Smartlead lead upload; this function owns the gate and
 * persistence so the gate primitive is exercised end-to-end.
 */

export type SendBatchCtx = {
  event: { data: { campaign_id: string; batch_date: string } };
  step: ApprovalStep;
  db?: DbPort;
};

export async function runSendBatchGenerate({ event, step, db: dbOverride }: SendBatchCtx) {
  const { campaign_id, batch_date } = event.data;
  const db = dbOverride ?? serviceClient();

  const campaign = await step.run("load-campaign", async () => {
    const { data, error } = await db
      .from("campaigns")
      .select("id, customer_id, sequence_id, daily_cap, status, smartlead_campaign_id")
      .eq("id", campaign_id)
      .single();
    if (error || !data) throw error ?? new Error("Campaign not found");
    return data;
  });

  if (campaign.status !== "warmup" && campaign.status !== "sending") {
    return { status: "skipped", reason: `campaign.status=${campaign.status}` };
  }

  const batchId = await step.run("create-batch", async () => {
    const { data, error } = await db
      .from("send_batches")
      .insert({
        campaign_id: campaign.id,
        batch_date,
        prospect_count: campaign.daily_cap,
        status: "pending_approval",
        payload_json: {
          customer_id: campaign.customer_id,
          sequence_id: campaign.sequence_id,
          smartlead_campaign_id: campaign.smartlead_campaign_id,
        } as unknown as object,
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("Could not create send_batch");
    return data.id;
  });

  const outcome = await withOperatorApproval({
    step,
    db,
    type: "send_batch",
    entityId: batchId,
    customerId: campaign.customer_id,
    payloadJson: { campaign_id: campaign.id, batch_date, daily_cap: campaign.daily_cap },
    timeout: "2d",
    onDecision: async ({ approved }) => {
      const { error: batchErr } = await db
        .from("send_batches")
        .update({
          status: approved ? "approved" : "rejected",
          approved_at: new Date().toISOString(),
        })
        .eq("id", batchId);
      if (batchErr) throw batchErr;
    },
  });

  if (outcome.kind === "timeout") {
    await step.run("mark-batch-failed", async () => {
      await db.from("send_batches").update({ status: "failed" }).eq("id", batchId);
    });
    return { status: "timeout", batchId };
  }

  if (outcome.approved) {
    const isFirstApproved = await step.run("count-prior-approved-batches", async () => {
      const { count, error } = await db
        .from("send_batches")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaign.id)
        .eq("status", "approved")
        .neq("id", batchId);
      // Re-throw on transient DB error so Inngest retries this step (≤3 attempts
      // w/ exponential backoff). Silent-dropping the funnel event would permanently
      // lose `sequence_activated` for a customer's first approved batch.
      if (error) throw error;
      return (count ?? 0) === 0;
    });

    if (isFirstApproved) {
      // `$insert_id` keyed on first_batch_id collapses retries within
      // PostHog's 24h dedup window. `sequence_activated` fires exactly once
      // per campaign (when the first batch is approved), so the batch id is
      // the natural stable key — any retry of this step re-derives the same
      // id and PostHog drops the duplicate.
      await emitFunnelEvent(
        step,
        "emit-sequence-activated-funnel",
        campaign.customer_id,
        "sequence_activated",
        {
          campaign_id: campaign.id,
          sequence_id: campaign.sequence_id,
          first_batch_id: batchId,
          batch_date,
        },
        batchId,
      );
    }
  }

  return {
    status: outcome.decision.decision,
    batchId,
    approvalId: outcome.approvalId,
  };
}

export const sendBatchGenerate = inngest.createFunction(
  { id: "send-batch-generate", name: "Daily send batch generation + approval" },
  { event: "send_batch/generate" },
  async ({ event, step }) =>
    runSendBatchGenerate({
      event: event as SendBatchCtx["event"],
      step: step as unknown as ApprovalStep,
    }),
);
