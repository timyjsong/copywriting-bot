import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { rewrite, brandVoice } from "@copywriting-bot/agents";

/**
 * onboardingPipeline — durable workflow that runs after a customer completes
 * the onboarding wizard.
 *
 * Steps:
 *   1. Scrape brand voice from customer URL (Brand Voice Scraper agent).
 *   2. Generate full rewritten sequence (Rewrite Agent).
 *   3. Persist rewrite as pending_approval sequence + create approval queue item.
 *   4. Wait for operator approval (PRD §5.2 approval gate primitive).
 *   5. On approve: mark sequence approved + emit rewrite/approved.
 *   6. On reject: emit rewrite/rejected for analytics.
 */

export const onboardingPipeline = inngest.createFunction(
  { id: "onboarding-pipeline", name: "Customer onboarding pipeline" },
  { event: "onboarding/completed" },
  async ({ event, step }) => {
    const { customer_id, sequence_id } = event.data;
    const db = serviceClient();

    // Step 1: fetch sequence + brand voice scrape
    const sequence = await step.run("load-sequence", async () => {
      const { data, error } = await db
        .from("sequences")
        .select("*")
        .eq("id", sequence_id)
        .single();
      if (error) throw error;
      return data;
    });

    const voiceProfile = await step.run("scrape-brand-voice", async () => {
      // Real implementation fetches the customer URL; this stub is replaced in Phase 2.
      const url = (sequence.voice_profile_json as { url?: string } | null)?.url ?? "";
      const content = (sequence.voice_profile_json as { content?: string } | null)?.content ?? "";
      if (!url || !content) {
        return null;
      }
      const out = await brandVoice.runBrandVoiceAgent({ url, content });
      return out.ok ? out.result : null;
    });

    // Step 2: rewrite
    const rewriteOutcome = await step.run("rewrite-sequence", async () => {
      if (!voiceProfile) {
        throw new Error("Brand voice profile required before rewrite");
      }
      const icp = (sequence.icp_json as Parameters<typeof rewrite.runRewriteAgent>[0]["icp"]) ?? null;
      if (!icp) throw new Error("ICP definition missing");
      return rewrite.runRewriteAgent({
        original_sequence: sequence.original_text,
        brand_voice: voiceProfile,
        icp,
        customer_id,
      });
    });

    if (!rewriteOutcome.ok) {
      throw new Error(`Rewrite Agent failed: ${rewriteOutcome.error}`);
    }

    // Step 3: persist rewrite + create approval queue item
    const approvalId = await step.run("create-approval", async () => {
      const rewrittenText = rewriteOutcome.result.emails
        .map((e) => `Step ${e.step} (Day ${e.send_delay_days}) [${e.purpose}]\nSubject: ${e.subject}\n\n${e.body}`)
        .join("\n\n---\n\n");

      const { error: updateErr } = await db
        .from("sequences")
        .update({ rewritten_text: rewrittenText, status: "pending_approval" })
        .eq("id", sequence_id);
      if (updateErr) throw updateErr;

      const { data: approval, error: insErr } = await db
        .from("approvals_queue")
        .insert({
          type: "rewrite",
          entity_id: sequence_id,
          customer_id,
          payload_json: rewriteOutcome.result as unknown as object,
          status: "pending",
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      return approval.id;
    });

    // Step 4: wait for operator approval (PRD-mandated gate, §5.2)
    const decision = await step.waitForEvent("await-operator-approval", {
      event: "operator.approval",
      timeout: "7d",
      if: `async.data.id == "${approvalId}"`,
    });

    if (!decision) {
      // Timed out — escalate to operator via support agent
      return { status: "timeout", approvalId };
    }

    // Step 5: persist decision
    await step.run("apply-decision", async () => {
      const status = decision.data.decision === "reject" ? "rejected" : "approved";
      await db
        .from("approvals_queue")
        .update({
          status: decision.data.decision === "reject" ? "rejected" : "approved",
          operator_action: decision.data.decision,
          operator_notes: decision.data.notes ?? null,
          decided_at: new Date().toISOString(),
        })
        .eq("id", approvalId);
      await db.from("sequences").update({ status, approved_at: new Date().toISOString() }).eq("id", sequence_id);
    });

    return { status: decision.data.decision, approvalId, customer_id, sequence_id };
  },
);
