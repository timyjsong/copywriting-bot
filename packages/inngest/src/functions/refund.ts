import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import type { DbPort } from "./_db.js";
import { withOperatorApproval, type ApprovalStep } from "./_approval-gate.js";

/**
 * refundRequested — operator-initiated or webhook-driven refund flow.
 *
 * Phase 6 (PRD §7) — refunds run through the same approval queue primitive
 * as everything else, so the operator confirms before money moves. Stripe
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
  step: ApprovalStep;
  db?: DbPort;
};

export async function runRefundRequested({ event, step, db: dbOverride }: RefundRequestedCtx) {
  const { customer_id, stripe_charge_id, amount, currency, reason } = event.data;
  const db = dbOverride ?? serviceClient();

  const outcome = await withOperatorApproval({
    step,
    db,
    type: "refund",
    entityId: stripe_charge_id,
    customerId: customer_id,
    payloadJson: { amount, currency, reason },
    timeout: "5d",
    onDecision: async ({ approved }) => {
      if (!approved) return;
      const { error: custErr } = await db
        .from("customers")
        .update({ status: "churned" })
        .eq("id", customer_id);
      if (custErr) throw custErr;
    },
  });

  if (outcome.kind === "timeout") {
    return { status: "timeout", approvalId: outcome.approvalId };
  }
  return { status: outcome.status, approvalId: outcome.approvalId };
}

export const refundRequested = inngest.createFunction(
  { id: "refund-requested", name: "Refund request → operator approval → Stripe" },
  { event: "refund/requested" },
  async ({ event, step }) =>
    runRefundRequested({
      event: event as RefundRequestedCtx["event"],
      step: step as unknown as ApprovalStep,
    }),
);
