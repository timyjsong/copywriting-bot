import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@copywriting-bot/db/client";
import { inngest } from "@copywriting-bot/inngest/client";
import { captureException } from "@copywriting-bot/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  customer_id: z.string().uuid(),
  stripe_charge_id: z.string().min(1),
  amount: z.number().int().min(1),
  currency: z.string().min(3).max(8).default("usd"),
  reason: z.string().max(500).default(""),
});

/**
 * Operator-initiated refund.
 *
 * The webhook handler also emits `refund/requested` for Stripe-side
 * refunds/disputes; this endpoint lets the operator kick one off proactively
 * from the ops dashboard (e.g., 21-day milestone missed and customer asked).
 * Both paths land in the same Inngest function so the approval gate is
 * honoured even when *we* originated the refund.
 */
export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  try {
    const db = serviceClient();
    const { data: customer, error } = await db
      .from("customers")
      .select("id")
      .eq("id", parsed.data.customer_id)
      .maybeSingle();
    if (error || !customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    await inngest.send({
      name: "refund/requested",
      data: parsed.data,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    captureException(err, { phase: "operator_refund_request" });
    return NextResponse.json({ error: "Could not dispatch refund" }, { status: 500 });
  }
}
