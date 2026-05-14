import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { support } from "@copywriting-bot/agents";
import type { DbPort } from "./_db.js";

/**
 * supportReplyPipeline — inbound customer email → triage → operator approval.
 *
 * PRD §5.1: Support/Replier Agent triages refund/question/objection/spam and
 * drafts a reply for operator review. Spam is filtered before queueing.
 */

export type SupportReplyCtx = {
  event: {
    data: {
      customer_email: string;
      subject: string;
      body: string;
      recent_thread?: string;
      twenty_one_day_metric_missed?: boolean;
    };
  };
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    waitForEvent: (
      id: string,
      opts: { event: string; timeout: string; if: string },
    ) => Promise<{ data: { decision: string; notes?: string | null } } | null>;
  };
  db?: DbPort;
};

export async function runSupportReplyPipeline({ event, step, db: dbOverride }: SupportReplyCtx) {
  const { customer_email, subject, body, recent_thread, twenty_one_day_metric_missed } = event.data;
  const db = dbOverride ?? serviceClient();

  const triage = await step.run("triage", async () => {
    const res = await support.runSupportAgent({
      customer_email,
      subject,
      body,
      recent_thread: recent_thread ?? "",
      twenty_one_day_metric_missed: twenty_one_day_metric_missed ?? false,
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

  // Re-throw on DB error so Inngest retries this step (≤3 attempts w/
  // exponential backoff). Silent failure would leave the approval row in
  // 'pending' while the function reports success, masking a stuck queue.
  await step.run("apply-decision", async () => {
    const { error } = await db
      .from("approvals_queue")
      .update({
        status: decision.data.decision === "reject" ? "rejected" : "approved",
        operator_action: decision.data.decision,
        operator_notes: decision.data.notes ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq("id", approvalId);
    if (error) throw error;
  });

  return { status: decision.data.decision, approvalId, category: triage.category };
}

export const supportReplyPipeline = inngest.createFunction(
  { id: "support-reply-pipeline", name: "Support reply triage + approval" },
  { event: "support/inbound" },
  async ({ event, step }) =>
    runSupportReplyPipeline({
      event: event as SupportReplyCtx["event"],
      step: step as unknown as SupportReplyCtx["step"],
    }),
);
