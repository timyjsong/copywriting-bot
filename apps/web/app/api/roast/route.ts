import { NextResponse } from "next/server";
import { runRoastAgent } from "@copywriting-bot/agents/roast";
import { RoastRequest } from "@copywriting-bot/shared/schemas";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureException, captureServerEventSafe } from "@copywriting-bot/shared/observability";
import { inngest } from "@copywriting-bot/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = RoastRequest.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { email, sequence, source } = parsed.data;

  // Funnel emission is best-effort: must never block the roast a user just
  // pasted in. The safe wrapper already swallows in-flight errors, but if it
  // ever escapes (Sentry down, etc.) we still want to serve the result.
  // captureException is bulletproofed at the source but we wrap it again so
  // any future regression in the primitive can't 500 the user.
  try {
    await captureServerEventSafe(email, "submitted_email", { source: source ?? null });
  } catch (err) {
    try {
      captureException(err, { phase: "roast_funnel_emission" });
    } catch {
      // Total observability failure — log to stderr and continue. The roast
      // is what the user paid for; telemetry is gravy.
      // eslint-disable-next-line no-console
      console.error("[copywriting-bot] roast funnel: total observability failure", err);
    }
  }

  const outcome = await runRoastAgent({ sequence, source });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 502 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("roasts")
    .insert({
      email,
      source: source ?? null,
      input_text: sequence,
      result_json: outcome.result as unknown as object,
      overall_score: outcome.result.overall_score,
      is_real_cold_email: outcome.result.is_real_cold_email,
    })
    .select("id")
    .single();

  if (error) {
    // Hard fail: we still send the result to the user but log the persistence issue.
    return NextResponse.json(
      { error: "Roast generated but could not be persisted. Try again." },
      { status: 502 },
    );
  }

  // Fire-and-forget side effects (Inngest will retry on failure).
  await inngest.send({
    name: "roast/submitted",
    data: { roast_id: data.id, email, source },
  });

  return NextResponse.json({ result: outcome.result, roast_id: data.id });
}
