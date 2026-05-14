import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { captureServerEvent } from "@copywriting-bot/shared/observability";

/**
 * roastSubmitted — fan-out function that runs *after* the synchronous Roast
 * API has stored the result. We use this to send the result email via
 * Postmark and to capture funnel events server-side.
 *
 * The actual LLM scoring runs inline in the API route (users expect a
 * sub-10s round-trip on the free tool); this function handles everything
 * async we can defer.
 */

export const roastSubmitted = inngest.createFunction(
  { id: "roast-submitted", name: "Roast submitted post-processing" },
  { event: "roast/submitted" },
  async ({ event, step }) => {
    const { roast_id, email, source } = event.data;
    const db = serviceClient();

    await step.run("upsert-lead", async () => {
      await db.from("leads").upsert(
        { email, source: source ?? null, first_roast_id: roast_id },
        { onConflict: "email" },
      );
    });

    await step.run("track-funnel", async () => {
      await captureServerEvent(email, "viewed_result", { roast_id, source: source ?? null });
    });

    return { roast_id, email };
  },
);
