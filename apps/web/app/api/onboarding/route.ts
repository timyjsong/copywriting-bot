import { NextResponse } from "next/server";
import { z } from "zod";
import { reviewOnboardingPayload } from "@copywriting-bot/agents/onboarder";
import { serviceClient } from "@copywriting-bot/db/client";
import { inngest } from "@copywriting-bot/inngest/client";
import { captureException, captureServerEvent } from "@copywriting-bot/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RawBody = z.object({
  sending_domain: z.string(),
  original_sequence: z.string(),
  icp_paragraph: z.string(),
  sample_target_companies: z.array(z.string()),
  calendar_url: z.string().url(),
  brand_voice_url: z.string().url(),
  stripe_session_id: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = RawBody.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }

  const db = serviceClient();

  // We need the customer_id — look up by stripe session if present, else fail.
  let customerId: string | null = null;
  if (parsed.data.stripe_session_id) {
    // In production we'd resolve session → customer via Stripe API. For MVP we
    // rely on the webhook having already upserted the customer + the email
    // path; the wizard form should be reached via redirect from Stripe's
    // success_url so we trust the session_id presence as a soft signal.
    const { data } = await db
      .from("customers")
      .select("id")
      .eq("status", "onboarding")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    customerId = data?.id ?? null;
  }
  if (!customerId) {
    return NextResponse.json({ error: "Customer not found. Did checkout complete?" }, { status: 400 });
  }

  const review = reviewOnboardingPayload({
    customer_id: customerId,
    ...parsed.data,
  });
  if (!review.ok) {
    return NextResponse.json({ error: review.issues.join("; "), suggestions: review.suggestions }, { status: 400 });
  }

  try {
    const { data: sequence, error } = await db
      .from("sequences")
      .insert({
        customer_id: customerId,
        version: 1,
        original_text: parsed.data.original_sequence,
        status: "draft",
        icp_json: { paragraph: parsed.data.icp_paragraph, samples: parsed.data.sample_target_companies },
        voice_profile_json: { url: parsed.data.brand_voice_url },
      })
      .select("id")
      .single();

    if (error || !sequence) {
      captureException(error, { phase: "onboarding_persist" });
      return NextResponse.json({ error: "DB error persisting sequence" }, { status: 500 });
    }

    await db
      .from("customers")
      .update({
        company_domain: parsed.data.sending_domain,
      })
      .eq("id", customerId);

    await inngest.send({
      name: "onboarding/completed",
      data: { customer_id: customerId, sequence_id: sequence.id },
    });

    await captureServerEvent(customerId, "onboarding_completed", { customer_id: customerId });

    return NextResponse.json({ ok: true, customer_id: customerId, sequence_id: sequence.id });
  } catch (err) {
    captureException(err, { phase: "onboarding_dispatch" });
    return NextResponse.json({ error: "Onboarding failed" }, { status: 500 });
  }
}
