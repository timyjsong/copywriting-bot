import { NextResponse } from "next/server";
import Stripe from "stripe";
import { serverEnv } from "@copywriting-bot/shared/env";
import { serviceClient } from "@copywriting-bot/db/client";
import { inngest } from "@copywriting-bot/inngest/client";
import { captureException } from "@copywriting-bot/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook handler — verifies the signature and dispatches an Inngest
 * event for downstream durable work.
 *
 * Important: this route must read the raw body (not parsed JSON) for signature
 * verification. We use `req.text()` and Stripe's `constructEvent`.
 */

let _stripe: Stripe | null = null;
function stripe(): Stripe {
  if (_stripe) return _stripe;
  _stripe = new Stripe(serverEnv().STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" });
  return _stripe;
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, sig, serverEnv().STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    captureException(err, { agent: "stripe_webhook", phase: "verify" });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const email = session.customer_details?.email ?? session.customer_email;
        if (!email) {
          return NextResponse.json({ ok: true, ignored: "no email on session" });
        }

        const db = serviceClient();
        const { data: customer, error } = await db
          .from("customers")
          .upsert(
            {
              email,
              stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
              tier: "full_rewrite",
              status: "onboarding",
              signup_source: "stripe_checkout",
            },
            { onConflict: "email" },
          )
          .select("id")
          .single();
        if (error || !customer) {
          captureException(error, { phase: "upsert_customer" });
          return NextResponse.json({ error: "DB error" }, { status: 500 });
        }

        await inngest.send({
          // Stripe re-delivers on 5xx/timeout. Keying the Inngest event on
          // `session.id` (unique per checkout) makes duplicate deliveries
          // collapse to a single function run — Inngest's event-id dedup
          // window catches it before the funnel emit ever sees a retry.
          id: `stripe-checkout-${session.id}`,
          name: "stripe/checkout.completed",
          data: {
            stripe_session_id: session.id,
            stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
            customer_email: email,
            amount_total: session.amount_total ?? 0,
            currency: session.currency ?? "usd",
            created_customer_id: customer.id,
          },
        });
        break;
      }

      case "charge.refunded":
      case "charge.dispute.created": {
        // Phase 6 — record the refund/dispute and queue an operator review.
        const charge = event.data.object as Stripe.Charge;
        const email =
          (typeof charge.billing_details?.email === "string" ? charge.billing_details.email : null) ??
          (typeof (charge as unknown as { receipt_email?: string }).receipt_email === "string"
            ? (charge as unknown as { receipt_email: string }).receipt_email
            : null);
        if (!email) {
          return NextResponse.json({ ok: true, ignored: "no email on charge" });
        }
        const db = serviceClient();
        const { data: customer } = await db
          .from("customers")
          .select("id")
          .eq("email", email)
          .maybeSingle();
        if (!customer) {
          return NextResponse.json({ ok: true, ignored: "customer not found" });
        }
        await inngest.send({
          name: "refund/requested",
          data: {
            customer_id: customer.id,
            stripe_charge_id: charge.id,
            amount: charge.amount_refunded ?? charge.amount,
            currency: charge.currency,
            reason: event.type === "charge.dispute.created" ? "stripe_dispute" : "stripe_refund",
          },
        });
        break;
      }

      default:
        // ignore other events
        break;
    }
  } catch (err) {
    captureException(err, { agent: "stripe_webhook", phase: "dispatch", event_type: event.type });
    return NextResponse.json({ error: "Dispatch error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
