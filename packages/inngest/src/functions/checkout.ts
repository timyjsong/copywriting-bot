import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureServerEvent } from "@copywriting-bot/shared/observability";

/**
 * checkoutCompleted — fans out after a Stripe checkout.session.completed event
 * is verified by the webhook handler. Creates/updates the customer record and
 * primes them for onboarding.
 */

export const checkoutCompleted = inngest.createFunction(
  { id: "checkout-completed", name: "Stripe checkout completed" },
  { event: "stripe/checkout.completed" },
  async ({ event, step }) => {
    const { customer_email, stripe_customer_id, created_customer_id } = event.data;
    const db = serviceClient();

    await step.run("upgrade-customer-tier", async () => {
      await db
        .from("customers")
        .update({
          stripe_customer_id,
          tier: "full_rewrite",
          status: "onboarding",
        })
        .eq("id", created_customer_id);
    });

    await step.run("track-funnel", async () => {
      await captureServerEvent(customer_email, "completed_checkout", {
        customer_id: created_customer_id,
      });
    });

    return { customer_id: created_customer_id };
  },
);
