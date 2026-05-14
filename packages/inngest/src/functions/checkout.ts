import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureServerEvent, funnelInsertId } from "@copywriting-bot/shared/observability";
import type { FunnelStep } from "./_funnel.js";

/**
 * checkoutCompleted — fans out after a Stripe checkout.session.completed event
 * is verified by the webhook handler. Creates/updates the customer record and
 * primes them for onboarding.
 *
 * Retry semantics: Stripe will re-deliver the webhook on 5xx/timeout; the
 * webhook now passes `id: stripe-checkout-${session_id}` to `inngest.send`,
 * so duplicate deliveries collapse to a single Inngest event. As belt-and-
 * suspenders the funnel emit also stamps `$insert_id` keyed on the same
 * `stripe_session_id` — same pattern iter 21 used for `viewed_result`, so a
 * step retry that already hit PostHog can't double-count `completed_checkout`.
 */

type CheckoutCompletedCtx = {
  event: {
    data: {
      stripe_session_id: string;
      stripe_customer_id: string | null;
      customer_email: string;
      created_customer_id: string;
    };
  };
  step: FunnelStep;
  db?: ReturnType<typeof serviceClient>;
};

/**
 * Pure runner — split from `inngest.createFunction` so tests can inject a
 * fake db + step without spinning up Inngest. Matches the DI seam used by
 * `runRoastSubmitted`, `runOnboardingPipeline`, etc.
 */
export async function runCheckoutCompleted(ctx: CheckoutCompletedCtx) {
  const { customer_email, stripe_customer_id, stripe_session_id, created_customer_id } =
    ctx.event.data;
  const db = ctx.db ?? serviceClient();

  await ctx.step.run("upgrade-customer-tier", async () => {
    await db
      .from("customers")
      .update({
        stripe_customer_id,
        tier: "full_rewrite",
        status: "onboarding",
      })
      .eq("id", created_customer_id);
  });

  await ctx.step.run("track-funnel", async () => {
    // `$insert_id` keyed on stripe_session_id is the dedup token PostHog
    // uses to drop duplicates across step retries / re-delivered webhooks.
    // stripe_session_id is unique-per-checkout, so re-firing the same
    // Inngest event always lands on the same insert_id.
    await captureServerEvent(customer_email, "completed_checkout", {
      customer_id: created_customer_id,
      stripe_session_id,
      $insert_id: funnelInsertId("completed_checkout", stripe_session_id),
    });
  });

  return { customer_id: created_customer_id };
}

export const checkoutCompleted = inngest.createFunction(
  { id: "checkout-completed", name: "Stripe checkout completed" },
  { event: "stripe/checkout.completed" },
  async ({ event, step }) =>
    runCheckoutCompleted({ event, step: step as unknown as FunnelStep }),
);
