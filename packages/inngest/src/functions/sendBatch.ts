import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { emitFunnelEvent, type FunnelStep } from "./_funnel.js";

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
  step: FunnelStep & {
    waitForEvent: (
      id: string,
      opts: { event: string; timeout: string; if: string },
    ) => Promise<{ data: { decision: string; notes?: string | null } } | null>;
  };
};

export async function runSendBatchGenerate({ event, step }: SendBatchCtx) {
  const { campaign_id, batch_date } = event.data;
  const db = serviceClient();

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

  const approvalId = await step.run("create-approval", async () => {
    const { data, error } = await db
      .from("approvals_queue")
      .insert({
        type: "send_batch",
        entity_id: batchId,
        customer_id: campaign.customer_id,
        payload_json: { campaign_id: campaign.id, batch_date, daily_cap: campaign.daily_cap } as unknown as object,
        status: "pending",
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("Could not create approval");
    return data.id;
  });

  const decision = await step.waitForEvent("await-operator-approval", {
    event: "operator.approval",
    timeout: "2d",
    if: `async.data.id == "${approvalId}"`,
  });

  if (!decision) {
    await step.run("mark-batch-failed", async () => {
      await db.from("send_batches").update({ status: "failed" }).eq("id", batchId);
    });
    return { status: "timeout", batchId };
  }

  await step.run("apply-decision", async () => {
    const finalStatus = decision.data.decision === "reject" ? "rejected" : "approved";
    await db.from("send_batches").update({
      status: finalStatus,
      approved_at: new Date().toISOString(),
    }).eq("id", batchId);
    await db.from("approvals_queue").update({
      status: finalStatus === "rejected" ? "rejected" : "approved",
      operator_action: decision.data.decision,
      operator_notes: decision.data.notes ?? null,
      decided_at: new Date().toISOString(),
    }).eq("id", approvalId);
  });

  if (decision.data.decision !== "reject") {
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
      );
    }
  }

  return { status: decision.data.decision, batchId, approvalId };
}

export const sendBatchGenerate = inngest.createFunction(
  { id: "send-batch-generate", name: "Daily send batch generation + approval" },
  { event: "send_batch/generate" },
  async ({ event, step }) =>
    runSendBatchGenerate({
      event: event as SendBatchCtx["event"],
      step: step as unknown as SendBatchCtx["step"],
    }),
);
