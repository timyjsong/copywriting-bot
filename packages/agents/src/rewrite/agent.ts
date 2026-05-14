import { z } from "zod";
import {
  BrandVoiceProfile,
  IcpDefinition,
  type BrandVoiceProfileT,
  type IcpDefinitionT,
} from "@copywriting-bot/shared/schemas";
import { addBreadcrumb, captureException } from "@copywriting-bot/shared/observability";
import { callJsonAgent, extractJsonObject } from "../client.js";

/**
 * Rewrite Agent — paid-customer sequence rewriter.
 *
 * Takes the customer's original sequence + brand-voice profile + ICP and
 * produces a rewritten sequence following the SaaS-to-SaaS playbook. Output
 * gets routed to the operator approval queue (PRD §4.2 step 4).
 *
 * Model: Sonnet 4.6 (development tier).
 */

const SYSTEM_PROMPT = `You are the Rewrite Agent for Copywriting Bot. Your job:
rewrite a B2B SaaS founder's cold-email sequence using the SaaS-to-SaaS
playbook, the customer's brand-voice profile, and their ICP. You optimise an
existing sequence — you do NOT generate from a blank brief.

INPUTS:
- Original sequence (verbatim text, possibly multiple emails)
- Brand voice profile (tone, positioning, key phrases, avoid phrases)
- ICP definition (industry, stage, size, buyer titles, pain signals, geo)

OUTPUT: a single JSON object with this shape:

{
  "emails": [
    {
      "step": 1,
      "purpose": "open" | "follow_up" | "bump" | "breakup",
      "send_delay_days": integer,
      "subject": "...",
      "body": "...",
      "personalisation_tokens": ["{{first_name}}", "{{company}}", ...],
      "diff_summary": "...",
      "new_claims": ["claim 1", "claim 2"]    // empty if no new claims
    },
    ...
  ],
  "playbook_used": "...",                       // which SaaS-to-SaaS pattern
  "expected_reply_rate_band": "2-4%" | "4-7%" | "7-10%" | "10%+",
  "guardrail_flags": ["..."],                   // any flags for operator review
  "rationale": "..."                            // 1-paragraph rationale
}

RULES:
1. NEVER invent claims about the customer's product. If a fact isn't in the
   inputs, you must omit it. The 'new_claims' field exists so operator review
   can verify nothing was hallucinated — list every assertion that did not
   appear verbatim in the original sequence.
2. RESPECT the brand voice's 'avoid_phrases' list — never use any of them.
3. KEEP the sequence length identical to the original unless the original has
   <3 emails (in which case extend to a 4-email default), or >7 (trim to 7).
4. Subject lines: <=8 words, no clickbait, no emojis, lowercase preferred.
5. Bodies: 50–110 words ideal. One CTA per email. CTAs must be specific.
6. RETURN ONLY the JSON object — no prose, no markdown commentary.`;

export const RewriteEmail = z.object({
  step: z.number().int().min(1).max(10),
  purpose: z.enum(["open", "follow_up", "bump", "breakup"]),
  send_delay_days: z.number().int().min(0).max(30),
  subject: z.string().min(1).max(120),
  body: z.string().min(40).max(2_000),
  personalisation_tokens: z.array(z.string()),
  diff_summary: z.string().max(400),
  new_claims: z.array(z.string()),
});

export const RewriteResult = z.object({
  emails: z.array(RewriteEmail).min(1).max(10),
  playbook_used: z.string().min(3).max(120),
  expected_reply_rate_band: z.enum(["2-4%", "4-7%", "7-10%", "10%+"]),
  guardrail_flags: z.array(z.string()),
  rationale: z.string().min(20).max(2_000),
});
export type RewriteResultT = z.infer<typeof RewriteResult>;

export type RewriteInput = {
  original_sequence: string;
  brand_voice: BrandVoiceProfileT;
  icp: IcpDefinitionT;
  customer_id: string;
};

export type RewriteOutcome =
  | { ok: true; result: RewriteResultT }
  | { ok: false; error: string };

export async function runRewriteAgent(input: RewriteInput): Promise<RewriteOutcome> {
  const voiceValidation = BrandVoiceProfile.safeParse(input.brand_voice);
  const icpValidation = IcpDefinition.safeParse(input.icp);
  if (!voiceValidation.success) return { ok: false, error: "Brand voice profile invalid." };
  if (!icpValidation.success) return { ok: false, error: "ICP definition invalid." };

  addBreadcrumb("rewrite.start", { customer_id: input.customer_id });

  const userMessage = JSON.stringify(
    {
      original_sequence: input.original_sequence,
      brand_voice: input.brand_voice,
      icp: input.icp,
    },
    null,
    2,
  );

  let raw = "";
  try {
    const res = await callJsonAgent({
      tier: "development",
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      maxTokens: 4_000,
    });
    raw = res.raw;
  } catch (err) {
    captureException(err, { agent: "rewrite", phase: "llm_call", customer_id: input.customer_id });
    return { ok: false, error: "Rewrite Agent could not reach the model." };
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    captureException(err, { agent: "rewrite", phase: "json_parse", raw });
    return { ok: false, error: "Rewrite Agent produced unparseable output." };
  }

  const validated = RewriteResult.safeParse(parsed);
  if (!validated.success) {
    captureException(new Error("RewriteResult schema mismatch"), {
      agent: "rewrite",
      phase: "schema",
      issues: validated.error.issues,
    });
    return { ok: false, error: "Rewrite Agent output did not match expected schema." };
  }

  return { ok: true, result: validated.data };
}
