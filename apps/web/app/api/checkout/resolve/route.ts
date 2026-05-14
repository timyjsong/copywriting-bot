import { NextResponse } from "next/server";
import Stripe from "stripe";
import { serverEnv } from "@copywriting-bot/shared/env";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureException } from "@copywriting-bot/shared/observability";
import { ResolveCheckoutBody } from "./schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve a Stripe checkout session_id (from `success_url`) to the customer
 * row created by the webhook. Onboarding posts the session_id and we return
 * the customer_id, replacing the previous "most recent onboarding row" hack.
 *
 * Returns 202 with `pending: true` when the webhook has not yet inserted the
 * customer row — the client should retry. Returns 410 if the session has
 * expired and was never paid.
 */

let _stripe: Stripe | null = null;
function stripe(): Stripe {
  if (_stripe) return _stripe;
  _stripe = new Stripe(serverEnv().STRIPE_SECRET_KEY, { apiVersion: "2025-02-24.acacia" });
  return _stripe;
}

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ResolveCheckoutBody.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid session_id" }, { status: 400 });
  }

  try {
    const session = await stripe().checkout.sessions.retrieve(parsed.data.session_id);
    if (session.payment_status !== "paid") {
      return NextResponse.json({ pending: true, reason: "not_paid" }, { status: 202 });
    }
    const email = session.customer_details?.email ?? session.customer_email;
    if (!email) {
      return NextResponse.json({ error: "Session missing email" }, { status: 410 });
    }

    const db = serviceClient();
    const { data, error } = await db
      .from("customers")
      .select("id, status")
      .eq("email", email)
      .maybeSingle();

    if (error) {
      captureException(error, { phase: "resolve_customer" });
      return NextResponse.json({ error: "DB error" }, { status: 500 });
    }
    if (!data) {
      // Webhook hasn't processed yet; client should retry.
      return NextResponse.json({ pending: true, reason: "webhook_pending" }, { status: 202 });
    }

    return NextResponse.json({ customer_id: data.id, status: data.status, email });
  } catch (err) {
    captureException(err, { phase: "resolve_session" });
    return NextResponse.json({ error: "Could not resolve session" }, { status: 500 });
  }
}
