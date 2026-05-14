import { NextResponse } from "next/server";
import { runRoastAgent } from "@copywriting-bot/agents/roast";
import { RoastRequest } from "@copywriting-bot/shared/schemas";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureException, emitFunnelEventBestEffort } from "@copywriting-bot/shared/observability";
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

  await emitFunnelEventBestEffort(
    email,
    "submitted_email",
    { source: source ?? null },
    { phase: "roast_funnel_emission" },
  );

  let outcome: Awaited<ReturnType<typeof runRoastAgent>>;
  try {
    outcome = await runRoastAgent({ sequence, source });
  } catch (err) {
    // Agent may throw for unexpected runtime failures (SDK bug, network blip
    // outside its own retry budget). Pin the contract: report + 502, never
    // let it 500 the user without a Sentry breadcrumb.
    captureException(err, { phase: "roast_agent_invoke" });
    return NextResponse.json({ error: "Roast service unavailable" }, { status: 502 });
  }
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

  // Inngest dispatch is best-effort: the row is already persisted, so the
  // user's roast_id is already valid. A reconciliation cron can re-fire any
  // missed `roast/submitted` events. Never 500 the user for a queue blip.
  try {
    await inngest.send({
      name: "roast/submitted",
      data: { roast_id: data.id, email, source },
    });
  } catch (err) {
    captureException(err, { phase: "roast_inngest_dispatch", roast_id: data.id });
  }

  return NextResponse.json({ result: outcome.result, roast_id: data.id });
}
