import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { support } from "@copywriting-bot/agents";

/**
 * supportReplyPipeline — inbound customer email → triage → operator approval.
 *
 * PRD §5.1: Support/Replier Agent triages refund/question/objection/spam and
 * drafts a reply for operator review. Spam is filtered before queueing.
 */
export const supportReplyPipeline = inngest.createFunction(
  { id: "support-reply-pipeline", name: "Support reply triage + approval" },
  { event: "support/inbound" },
  async ({ event, step }) => {
    const { customer_email, subject, body, recent_thread, twenty_one_day_metric_missed } = event.data;
    const db = serviceClient();

    const triage = await step.run("triage", async () => {
      const res = await support.runSupportAgent({
        customer_email,
        subject,
        body,
        recent_thread,
        twenty_one_day_metric_missed,
      });
      if (!res.ok) throw new Error(res.error);
      return res.triage;
    });

    if (triage.category === "spam") {
      return { status: "spam_filtered" };
    }

    const approvalId = await step.run("create-approval", async () => {
      const { data, error } = await db
        .from("approvals_queue")
        .insert({
          type: "support_reply",
          entity_id: customer_email,
          payload_json: {
            triage,
            inbound: { subject, body, recent_thread },
          } as unknown as object,
          status: "pending",
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("Could not create support approval");
      return data.id;
    });

    const decision = await step.waitForEvent("await-operator-approval", {
      event: "operator.approval",
      timeout: "3d",
      if: `async.data.id == "${approvalId}"`,
    });

    if (!decision) return { status: "timeout", approvalId };

    await step.run("apply-decision", async () => {
      await db
        .from("approvals_queue")
        .update({
          status: decision.data.decision === "reject" ? "rejected" : "approved",
          operator_action: decision.data.decision,
          operator_notes: decision.data.notes ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq("id", approvalId);
    });

    return { status: decision.data.decision, approvalId, category: triage.category };
  },
);
