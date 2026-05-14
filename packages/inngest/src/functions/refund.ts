import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import type { DbPort } from "./_db.js";

/**
 * refundRequested — operator-initiated or webhook-driven refund flow.
 *
 * Phase 6 (PRD §7) — refunds run through the same approval queue primitive as
 * everything else, so the operator confirms before money moves. Stripe
 * `charge.refunded` enters here too (post-fact) so we record the refund and
 * mark the customer accordingly.
 */

export type RefundRequestedCtx = {
  event: {
    data: {
      customer_id: string;
      stripe_charge_id: string;
      amount: number;
      currency: string;
      reason: string;
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

export async function runRefundRequested({ event, step, db: dbOverride }: RefundRequestedCtx) {
  const { customer_id, stripe_charge_id, amount, currency, reason } = event.data;
  const db = dbOverride ?? serviceClient();

  const approvalId = await step.run("create-approval", async () => {
    const { data, error } = await db
      .from("approvals_queue")
      .insert({
        type: "refund",
        entity_id: stripe_charge_id,
        customer_id,
        payload_json: { amount, currency, reason } as unknown as object,
        status: "pending",
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("Could not create refund approval");
    return data.id;
  });

  const decision = await step.waitForEvent("await-operator-approval", {
    event: "operator.approval",
    timeout: "5d",
    if: `async.data.id == "${approvalId}"`,
  });

  if (!decision) return { status: "timeout", approvalId };

  // Re-throw on DB errors so Inngest retries this step (≤3 attempts w/
  // exponential backoff). Silent failure would leave the approval row in
  // 'pending' while the function reports success — masking a stuck queue
  // and (for approved refunds) leaving customers.status out of sync with
  // the Stripe refund that downstream code will issue.
  await step.run("apply-decision", async () => {
    const approved = decision.data.decision !== "reject";
    const { error: approvalErr } = await db
      .from("approvals_queue")
      .update({
        status: approved ? "approved" : "rejected",
        operator_action: decision.data.decision,
        operator_notes: decision.data.notes ?? null,
        decided_at: new Date().toISOString(),
      })
      .eq("id", approvalId);
    if (approvalErr) throw approvalErr;

    if (approved) {
      const { error: custErr } = await db
        .from("customers")
        .update({ status: "churned" })
        .eq("id", customer_id);
      if (custErr) throw custErr;
    }
  });

  return { status: decision.data.decision, approvalId };
}

export const refundRequested = inngest.createFunction(
  { id: "refund-requested", name: "Refund request → operator approval → Stripe" },
  { event: "refund/requested" },
  async ({ event, step }) =>
    runRefundRequested({
      event: event as RefundRequestedCtx["event"],
      step: step as unknown as RefundRequestedCtx["step"],
    }),
);
