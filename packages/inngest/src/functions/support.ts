import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { support } from "@copywriting-bot/agents";
import type { DbPort } from "./_db.js";
import { withOperatorApproval, type ApprovalStep } from "./_approval-gate.js";

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
  step: ApprovalStep;
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

  const outcome = await withOperatorApproval({
    step,
    db,
    type: "support_reply",
    entityId: customer_email,
    payloadJson: {
      triage,
      inbound: { subject, body, recent_thread },
    },
    timeout: "3d",
  });

  if (outcome.kind === "timeout") {
    return { status: "timeout", approvalId: outcome.approvalId };
  }
  return { status: outcome.status, approvalId: outcome.approvalId, category: triage.category };
}

export const supportReplyPipeline = inngest.createFunction(
  { id: "support-reply-pipeline", name: "Support reply triage + approval" },
  { event: "support/inbound" },
  async ({ event, step }) =>
    runSupportReplyPipeline({
      event: event as SupportReplyCtx["event"],
      step: step as unknown as ApprovalStep,
    }),
);
