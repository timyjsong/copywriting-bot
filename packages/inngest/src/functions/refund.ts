import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";

/**
 * refundRequested — operator-initiated or webhook-driven refund flow.
 *
 * Phase 6 (PRD §7) — refunds run through the same approval queue primitive as
 * everything else, so the operator confirms before money moves. Stripe
 * `charge.refunded` enters here too (post-fact) so we record the refund and
 * mark the customer accordingly.
 */
export const refundRequested = inngest.createFunction(
  { id: "refund-requested", name: "Refund request → operator approval → Stripe" },
  { event: "refund/requested" },
  async ({ event, step }) => {
    const { customer_id, stripe_charge_id, amount, currency, reason } = event.data;
    const db = serviceClient();

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

    await step.run("apply-decision", async () => {
      const approved = decision.data.decision !== "reject";
      await db
        .from("approvals_queue")
        .update({
          status: approved ? "approved" : "rejected",
          operator_action: decision.data.decision,
          operator_notes: decision.data.notes ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq("id", approvalId);

      if (approved) {
        await db
          .from("customers")
          .update({ status: "churned" })
          .eq("id", customer_id);
      }
    });

    return { status: decision.data.decision, approvalId };
  },
);
