import { z } from "zod";

/**
 * Canonical zod schemas used across apps + agents.
 *
 * Every external boundary (HTTP request, LLM JSON output, webhook payload)
 * is validated against one of these. Schemas live here so the apps and the
 * agents stay in lockstep on shapes.
 */

// --- Roast (free tool) ---

export const RoastDimension = z.enum([
  "subject_line",
  "opener_personalization",
  "value_clarity",
  "social_proof",
  "cta_strength",
  "sequencing",
]);
export type RoastDimensionT = z.infer<typeof RoastDimension>;

export const DimensionScore = z.object({
  dimension: RoastDimension,
  score: z.number().int().min(0).max(10),
  rationale: z.string().min(1).max(500),
});

export const RoastResult = z.object({
  is_real_cold_email: z.boolean(),
  refusal_reason: z.string().nullable(),
  overall_score: z.number().int().min(0).max(100),
  per_dimension: z.array(DimensionScore).length(6),
  worst_email_index: z.number().int().min(0).nullable(),
  rewrite_preview: z
    .object({
      subject: z.string(),
      body: z.string(),
      changed_phrases: z.array(z.string()),
    })
    .nullable(),
  share_caption: z.string().min(1).max(280),
});
export type RoastResultT = z.infer<typeof RoastResult>;

export const RoastRequest = z.object({
  email: z.string().email(),
  sequence: z
    .string()
    .min(40, "Sequence is too short to roast — paste at least one email")
    .max(20_000, "Sequence is too long — paste fewer than 20k characters"),
  source: z.string().max(200).optional(),
});
export type RoastRequestT = z.infer<typeof RoastRequest>;

// --- Customer onboarding ---

export const OnboardingPayload = z.object({
  customer_id: z.string().uuid(),
  sending_domain: z
    .string()
    .min(3)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Looks like an invalid domain"),
  original_sequence: z.string().min(40),
  icp_paragraph: z.string().min(20).max(2_000),
  sample_target_companies: z.array(z.string().min(1)).min(3).max(10),
  calendar_url: z.string().url(),
  brand_voice_url: z.string().url(),
});
export type OnboardingPayloadT = z.infer<typeof OnboardingPayload>;

// --- Approval queue ---

export const ApprovalType = z.enum([
  "rewrite",
  "send_batch",
  "refund",
  "outbound_email",
  "support_reply",
]);
export type ApprovalTypeT = z.infer<typeof ApprovalType>;

export const ApprovalDecision = z.object({
  approval_id: z.string().uuid(),
  decision: z.enum(["approve", "reject", "edit_and_approve"]),
  edited_payload: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(2_000).optional(),
});
export type ApprovalDecisionT = z.infer<typeof ApprovalDecision>;

// --- Brand voice ---

export const BrandVoiceProfile = z.object({
  tone: z.array(z.string()).min(1).max(8),
  positioning: z.string().max(500),
  key_phrases: z.array(z.string()).max(20),
  avoid_phrases: z.array(z.string()).max(20),
  reading_level: z.enum(["accessible", "professional", "technical"]),
  source_urls: z.array(z.string().url()),
});
export type BrandVoiceProfileT = z.infer<typeof BrandVoiceProfile>;

// --- ICP ---

export const IcpDefinition = z.object({
  industry: z.string(),
  company_stage: z.string(),
  size_range: z.string(),
  buyer_titles: z.array(z.string()).min(1),
  pain_signals: z.array(z.string()).min(1),
  geo: z.array(z.enum(["US", "UK", "CA", "AU"])).min(1),
});
export type IcpDefinitionT = z.infer<typeof IcpDefinition>;
