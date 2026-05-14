import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureServerEvent, funnelInsertId } from "@copywriting-bot/shared/observability";
import type { FunnelStep } from "./_funnel.js";

/**
 * roastSubmitted — fan-out function that runs *after* the synchronous Roast
 * API has stored the result. We use this to send the result email via
 * Postmark and to capture funnel events server-side.
 *
 * The actual LLM scoring runs inline in the API route (users expect a
 * sub-10s round-trip on the free tool); this function handles everything
 * async we can defer.
 */

type RoastSubmittedCtx = {
  event: { data: { roast_id: string; email: string; source?: string | null } };
  step: FunnelStep;
  db?: ReturnType<typeof serviceClient>;
};

/**
 * Pure runner — split from `inngest.createFunction` so tests can inject a
 * fake db + step without spinning up Inngest. Matches the DI seam used by
 * `runOnboardingPipeline`, `runSendBatchGenerate`, `runPerformanceDailyPull`.
 */
export async function runRoastSubmitted(ctx: RoastSubmittedCtx) {
  const { roast_id, email, source } = ctx.event.data;
  const db = ctx.db ?? serviceClient();

  await ctx.step.run("upsert-lead", async () => {
    await db.from("leads").upsert(
      { email, source: source ?? null, first_roast_id: roast_id },
      { onConflict: "email" },
    );
  });

  await ctx.step.run("track-funnel", async () => {
    // Belt-and-suspenders with the client emission in roast/page.tsx: client
    // can be blocked (ad-block, JS off, tab closed pre-render); this server
    // emit guarantees the funnel step lands. `$insert_id` keyed on roast_id
    // lets PostHog dedupe when both sides succeed — same logical event,
    // counted once. Same key on both sides is required for dedup to work.
    await captureServerEvent(email, "viewed_result", {
      roast_id,
      source: source ?? null,
      $insert_id: funnelInsertId("viewed_result", roast_id),
    });
  });

  return { roast_id, email };
}

export const roastSubmitted = inngest.createFunction(
  { id: "roast-submitted", name: "Roast submitted post-processing" },
  { event: "roast/submitted" },
  async ({ event, step }) =>
    runRoastSubmitted({ event, step: step as unknown as FunnelStep }),
);
