import { z } from "zod";
import { callJsonAgent, extractJsonObject } from "../client.js";
import { addBreadcrumb, captureException } from "@copywriting-bot/shared/observability";

/**
 * Outbound Agent — sources B2B SaaS prospects, writes a personalised cold
 * email to each, queues for operator approval.
 *
 * The agent itself only handles the LLM personalisation step here; prospect
 * sourcing/enrichment lives in ./apollo.ts. PRD §4 — bot eats its own dog food,
 * so the email pattern mirrors what we sell.
 */

const SYSTEM_PROMPT = `You are the Outbound Agent for Copywriting Bot — a
productized service that rewrites B2B SaaS founders' cold-email sequences. You
are writing cold emails on behalf of Copywriting Bot itself, to B2B SaaS
founders who fit our ICP.

PRODUCT FACTS (do not invent beyond these):
- We rewrite cold-email sequences using a SaaS-to-SaaS playbook
- We stand up Smartlead-based send infrastructure on the customer's domain
- We monitor 30 days of performance
- Price: $297 one-time
- Refund offered automatically if 21-day reply-rate target missed
- We only serve B2B SaaS-to-SaaS companies in US/UK/CA/AU

OUTPUT a JSON object:
{
  "messages": [
    {
      "prospect_id": "...",
      "subject": "...",        // <=8 words, lowercase preferred
      "body": "...",           // 60-90 words, one CTA
      "signal_used": "...",    // which prospect signal you anchored on
      "guardrail_flags": ["..."]
    }
  ]
}

RULES:
1. Never claim metrics ("3x reply rate", "10% conversion") unless given the
   exact metric in the prospect signal data.
2. The CTA must be specific — e.g., "want me to send a 60-second video roast of
   your current sequence?" — never a generic meeting ask.
3. Open with the signal (e.g., "Saw you launched X yesterday"). No "Hope this
   finds you well."
4. RETURN ONLY the JSON.`;

export const OutboundMessage = z.object({
  prospect_id: z.string(),
  subject: z.string().min(1).max(120),
  body: z.string().min(40).max(1_200),
  signal_used: z.string().max(280),
  guardrail_flags: z.array(z.string()),
});
export const OutboundResult = z.object({
  messages: z.array(OutboundMessage).min(1).max(100),
});
export type OutboundResultT = z.infer<typeof OutboundResult>;

export type OutboundProspect = {
  id: string;
  name: string;
  role: string;
  company: string;
  company_domain: string;
  signal: string;
};

export async function runOutboundAgent(
  prospects: OutboundProspect[],
): Promise<{ ok: true; result: OutboundResultT } | { ok: false; error: string }> {
  if (prospects.length === 0) return { ok: false, error: "No prospects supplied." };
  if (prospects.length > 100) return { ok: false, error: "Batch over 100 prospects — split it." };

  addBreadcrumb("outbound.start", { count: prospects.length });

  let raw = "";
  try {
    const res = await callJsonAgent({
      tier: "development",
      systemPrompt: SYSTEM_PROMPT,
      userMessage: JSON.stringify({ prospects }, null, 2),
      maxTokens: 4_000,
    });
    raw = res.raw;
  } catch (err) {
    captureException(err, { agent: "outbound", phase: "llm_call" });
    return { ok: false, error: "Outbound Agent could not reach the model." };
  }

  try {
    const parsed = extractJsonObject(raw);
    const validated = OutboundResult.safeParse(parsed);
    if (!validated.success) return { ok: false, error: "Outbound result schema mismatch." };
    return { ok: true, result: validated.data };
  } catch (err) {
    captureException(err, { agent: "outbound", phase: "json_parse" });
    return { ok: false, error: "Outbound result unparseable." };
  }
}
