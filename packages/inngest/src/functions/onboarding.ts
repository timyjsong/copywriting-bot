import { inngest } from "../client.js";
import { serviceClient } from "@copywriting-bot/db/client";
import { rewrite, brandVoice } from "@copywriting-bot/agents";
import { emitFunnelEvent } from "./_funnel.js";
import type { DbPort } from "./_db.js";
import { withOperatorApproval, type ApprovalStep } from "./_approval-gate.js";

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

export type OnboardingPipelineCtx = {
  event: { data: { customer_id: string; sequence_id: string } };
  step: ApprovalStep;
  db?: DbPort;
};

export async function runOnboardingPipeline({ event, step, db: dbOverride }: OnboardingPipelineCtx) {
  const { customer_id, sequence_id } = event.data;
  const db = dbOverride ?? serviceClient();

  // Step 1: fetch sequence + brand voice scrape
  const sequence = await step.run("load-sequence", async () => {
    const { data, error } = await db
      .from("sequences")
      .select("*")
      .eq("id", sequence_id)
      .single();
    if (error) throw error;
    if (!data) throw new Error("Sequence not found");
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

  // Step 3: persist rewritten text before queueing the operator gate.
  await step.run("persist-rewrite", async () => {
    const rewrittenText = rewriteOutcome.result.emails
      .map((e) => `Step ${e.step} (Day ${e.send_delay_days}) [${e.purpose}]\nSubject: ${e.subject}\n\n${e.body}`)
      .join("\n\n---\n\n");

    const { error: updateErr } = await db
      .from("sequences")
      .update({ rewritten_text: rewrittenText, status: "pending_approval" })
      .eq("id", sequence_id);
    if (updateErr) throw updateErr;
  });

  // Step 4–5: approval gate primitive (PRD §5.2). On decision, persist the
  // sequences row alongside the approvals_queue write so a partial failure
  // can't leave the two out of sync.
  const outcome = await withOperatorApproval({
    step,
    db,
    type: "rewrite",
    entityId: sequence_id,
    customerId: customer_id,
    payloadJson: rewriteOutcome.result as unknown as object,
    timeout: "7d",
    onDecision: async ({ approved }) => {
      const { error: seqErr } = await db
        .from("sequences")
        .update({
          status: approved ? "approved" : "rejected",
          approved_at: new Date().toISOString(),
        })
        .eq("id", sequence_id);
      if (seqErr) throw seqErr;
    },
  });

  if (outcome.kind === "timeout") {
    return { status: "timeout", approvalId: outcome.approvalId };
  }

  if (outcome.approved) {
    // `$insert_id` keyed on approval_id collapses retries within PostHog's
    // 24h dedup window. The approval row is created once per (sequence_id,
    // operator_decision), so this id is stable across any step retry that
    // re-runs the funnel emit (e.g. transient PostHog 5xx).
    await emitFunnelEvent(
      step,
      "emit-rewrite-approved-funnel",
      customer_id,
      "rewrite_approved",
      {
        sequence_id,
        approval_id: outcome.approvalId,
        decision: outcome.decision.decision,
      },
      outcome.approvalId,
    );
  }

  return {
    status: outcome.decision.decision,
    approvalId: outcome.approvalId,
    customer_id,
    sequence_id,
  };
}

export const onboardingPipeline = inngest.createFunction(
  { id: "onboarding-pipeline", name: "Customer onboarding pipeline" },
  { event: "onboarding/completed" },
  async ({ event, step }) =>
    runOnboardingPipeline({
      event: event as OnboardingPipelineCtx["event"],
      step: step as unknown as ApprovalStep,
    }),
);
