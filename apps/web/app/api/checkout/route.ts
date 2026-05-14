import { NextResponse } from "next/server";
import Stripe from "stripe";
import { z } from "zod";
import { serverEnv, publicEnv } from "@copywriting-bot/shared/env";
import { captureException } from "@copywriting-bot/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().email().optional(),
  from_roast_id: z.string().uuid().optional(),
});

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
    payload = {};
  }
  const parsed = Body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const env = serverEnv();
  const pub = publicEnv();

  try {
    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: parsed.data.email,
      line_items: [
        env.STRIPE_PRICE_ID_FULL_REWRITE
          ? { price: env.STRIPE_PRICE_ID_FULL_REWRITE, quantity: 1 }
          : {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "Copywriting Bot — full rewrite + 30-day infra",
                  description:
                    "Full sequence rewrite, Smartlead campaign on your domain, 30 days of monitoring. 21-day reply-rate lift guarantee.",
                },
                unit_amount: 29_700,
              },
              quantity: 1,
            },
      ],
      metadata: parsed.data.from_roast_id ? { from_roast_id: parsed.data.from_roast_id } : undefined,
      success_url: `${pub.NEXT_PUBLIC_APP_URL}/onboarding?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${pub.NEXT_PUBLIC_APP_URL}/pricing?cancelled=1`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    captureException(err, { phase: "create_checkout_session" });
    return NextResponse.json({ error: "Could not create checkout session" }, { status: 500 });
  }
}
