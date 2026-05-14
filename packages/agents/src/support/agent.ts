import { z } from "zod";
import { callJsonAgent, extractJsonObject } from "../client.js";
import { addBreadcrumb, captureException } from "@copywriting-bot/shared/observability";

/**
 * Support/Replier Agent — triages inbound customer email and drafts a reply
 * that is routed to operator approval (PRD §5.1).
 */

const SYSTEM_PROMPT = `You are the Support/Replier Agent for Copywriting Bot.
Given an inbound customer email and recent thread context, you (a) classify
the intent, and (b) draft a reply for operator approval.

Categories:
- refund_request
- product_question
- billing_question
- complaint
- bug_report
- objection (sales pushback before purchase)
- spam (auto-replies, "unsubscribe", etc.)
- escalate_to_human (anything legal, security, press)

OUTPUT:
{
  "category": "...",
  "urgency": "low" | "medium" | "high",
  "draft_reply": "...",           // omit for spam
  "operator_notes": "...",         // 1 line of context
  "auto_offer_refund": boolean      // true if 21-day metric missed
}

RULES:
- Never make pricing promises beyond $297 one-time.
- Never offer custom features.
- Refund offers must be deferred to operator unless auto_offer_refund=true.
- 'spam' category gets an empty draft_reply.
- Return ONLY the JSON.`;

export const SupportTriage = z.object({
  category: z.enum([
    "refund_request",
    "product_question",
    "billing_question",
    "complaint",
    "bug_report",
    "objection",
    "spam",
    "escalate_to_human",
  ]),
  urgency: z.enum(["low", "medium", "high"]),
  draft_reply: z.string().max(4_000).optional(),
  operator_notes: z.string().max(500),
  auto_offer_refund: z.boolean(),
});
export type SupportTriageT = z.infer<typeof SupportTriage>;

export type SupportInput = {
  customer_email: string;
  subject: string;
  body: string;
  recent_thread: string;
  twenty_one_day_metric_missed: boolean;
};

export async function runSupportAgent(
  input: SupportInput,
): Promise<{ ok: true; triage: SupportTriageT } | { ok: false; error: string }> {
  addBreadcrumb("support.start", { from: input.customer_email });

  let raw = "";
  try {
    const res = await callJsonAgent({
      tier: "development",
      systemPrompt: SYSTEM_PROMPT,
      userMessage: JSON.stringify(input, null, 2),
      maxTokens: 1_500,
    });
    raw = res.raw;
  } catch (err) {
    captureException(err, { agent: "support", phase: "llm_call" });
    return { ok: false, error: "Support Agent could not reach the model." };
  }

  try {
    const parsed = extractJsonObject(raw);
    const validated = SupportTriage.safeParse(parsed);
    if (!validated.success) return { ok: false, error: "Support triage schema mismatch." };
    return { ok: true, triage: validated.data };
  } catch (err) {
    captureException(err, { agent: "support", phase: "json_parse" });
    return { ok: false, error: "Support triage unparseable." };
  }
}
