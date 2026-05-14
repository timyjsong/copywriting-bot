import { z } from "zod";
import { addBreadcrumb, captureException } from "@copywriting-bot/shared/observability";
import { callJsonAgent, extractJsonObject } from "../client.js";
import type { BrandVoiceProfileT, IcpDefinitionT } from "@copywriting-bot/shared/schemas";

/**
 * Send Infra Agent — provisions and operates Smartlead campaigns.
 *
 * Decision-level work (warmup schedule, daily cap escalation, batch sizing)
 * uses Sonnet 4.6. Per-email personalisation inside an approved batch uses
 * Haiku for cost reasons.
 *
 * This module exposes only the agent surface; the Smartlead HTTP client lives
 * in ./smartlead.ts so it can be mocked in tests.
 */

const WARMUP_SYSTEM_PROMPT = `You configure cold-email send infrastructure for a
B2B SaaS-to-SaaS productized service. Given a customer's sending domain age,
prior send history (if any), and target volume, output a 10-day warmup schedule
that minimises deliverability risk.

OUTPUT a JSON object:

{
  "schedule": [
    { "day": 1, "max_sends": integer, "ramp_reason": "..." },
    ...
  ],
  "final_daily_cap": integer,
  "abort_conditions": ["bounce_rate > 3%", "spam_complaint_rate > 0.1%", ...]
}

RULES:
- Start at <=20 sends on day 1 for fresh domains.
- Never exceed +30% day-over-day increase.
- Final daily cap should be <=80 for MVP unless explicit override.
- Return ONLY the JSON.`;

export const WarmupDay = z.object({
  day: z.number().int().min(1).max(60),
  max_sends: z.number().int().min(1).max(500),
  ramp_reason: z.string().max(280),
});

export const WarmupPlan = z.object({
  schedule: z.array(WarmupDay).min(7).max(30),
  final_daily_cap: z.number().int().min(1).max(500),
  abort_conditions: z.array(z.string()).min(1).max(20),
});
export type WarmupPlanT = z.infer<typeof WarmupPlan>;

export type WarmupInput = {
  customer_id: string;
  sending_domain: string;
  domain_age_days: number;
  prior_send_volume_30d: number;
  target_daily_cap: number;
};

export async function generateWarmupPlan(input: WarmupInput): Promise<
  { ok: true; plan: WarmupPlanT } | { ok: false; error: string }
> {
  addBreadcrumb("send_infra.warmup_plan", { customer_id: input.customer_id });

  let raw = "";
  try {
    const res = await callJsonAgent({
      tier: "development",
      systemPrompt: WARMUP_SYSTEM_PROMPT,
      userMessage: JSON.stringify(input, null, 2),
      maxTokens: 1_500,
    });
    raw = res.raw;
  } catch (err) {
    captureException(err, { agent: "send_infra", phase: "warmup_plan" });
    return { ok: false, error: "Warmup planner could not reach the model." };
  }

  try {
    const parsed = extractJsonObject(raw);
    const validated = WarmupPlan.safeParse(parsed);
    if (!validated.success) return { ok: false, error: "Warmup plan schema mismatch." };
    return { ok: true, plan: validated.data };
  } catch (err) {
    captureException(err, { agent: "send_infra", phase: "warmup_parse" });
    return { ok: false, error: "Warmup plan was unparseable." };
  }
}

/**
 * Generate a batch of personalised cold emails for a campaign send day.
 * Caller supplies the approved sequence (one template per step) and the day's
 * prospects; we personalise step 1 (the open) for the cohort scheduled today.
 */

const PERSONALISE_SYSTEM_PROMPT = `You personalise cold-email opens for a B2B
SaaS-to-SaaS campaign. Given (a) an approved email template with placeholder
tokens and (b) a list of prospects with metadata, produce one personalised
opener per prospect. Never invent claims about either side. Keep the rest of
the body identical to the template — you only edit the first 1-2 lines.

OUTPUT a JSON object:
{
  "messages": [
    { "prospect_id": "...", "subject": "...", "body": "...", "personalised_lines": ["...", "..."] }
  ]
}`;

export const PersonalisedMessage = z.object({
  prospect_id: z.string(),
  subject: z.string().min(1).max(120),
  body: z.string().min(40).max(2_000),
  personalised_lines: z.array(z.string()).max(4),
});
export const PersonaliseResult = z.object({
  messages: z.array(PersonalisedMessage).min(1).max(500),
});
export type PersonaliseResultT = z.infer<typeof PersonaliseResult>;

export type PersonaliseInput = {
  template_subject: string;
  template_body: string;
  brand_voice: BrandVoiceProfileT;
  icp: IcpDefinitionT;
  prospects: Array<{
    id: string;
    name?: string;
    role?: string;
    company?: string;
    company_domain?: string;
    signal?: string;
  }>;
};

export async function personaliseBatch(
  input: PersonaliseInput,
): Promise<{ ok: true; result: PersonaliseResultT } | { ok: false; error: string }> {
  if (input.prospects.length === 0) return { ok: false, error: "No prospects in batch." };

  addBreadcrumb("send_infra.personalise", { count: input.prospects.length });

  let raw = "";
  try {
    const res = await callJsonAgent({
      tier: "fast",
      systemPrompt: PERSONALISE_SYSTEM_PROMPT,
      userMessage: JSON.stringify(input, null, 2),
      maxTokens: 4_000,
    });
    raw = res.raw;
  } catch (err) {
    captureException(err, { agent: "send_infra", phase: "personalise" });
    return { ok: false, error: "Batch personaliser could not reach the model." };
  }

  try {
    const parsed = extractJsonObject(raw);
    const validated = PersonaliseResult.safeParse(parsed);
    if (!validated.success) return { ok: false, error: "Personalise result schema mismatch." };
    return { ok: true, result: validated.data };
  } catch (err) {
    captureException(err, { agent: "send_infra", phase: "personalise_parse" });
    return { ok: false, error: "Personalise result was unparseable." };
  }
}
