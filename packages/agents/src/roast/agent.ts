import { RoastResult, type RoastResultT } from "@copywriting-bot/shared/schemas";
import { callJsonAgent, extractJsonObject } from "../client.js";
import { addBreadcrumb, captureException } from "@copywriting-bot/shared/observability";

/**
 * Roast Agent — the free tool's brain.
 *
 * Scores a pasted cold-email sequence across the 6 PRD dimensions, identifies
 * the worst email, and produces a rewrite preview. Refuses gracefully when the
 * input is not actually a cold email (newsletter, marketing blast, ChatGPT
 * boilerplate, etc.) per PRD §8 risk mitigation.
 *
 * Model: Haiku (fast, cheap, high-volume).
 */

const SYSTEM_PROMPT = `You are the Roast Agent for Copywriting Bot — a productized
service that rewrites cold-email sequences for B2B SaaS founders selling to other
SaaS companies. You are NOT a generic copy critic. You score cold-email sequences
against a known-working playbook for B2B SaaS-to-SaaS outbound.

INPUT: a pasted cold-email sequence (one or more emails, in any text format —
the user may paste subjects + bodies, raw HTML, exported CSVs, etc.).

OUTPUT: a single JSON object matching this schema:

{
  "is_real_cold_email": boolean,
  "refusal_reason": string | null,   // only set if is_real_cold_email is false
  "overall_score": integer 0-100,
  "per_dimension": [                  // exactly 6 entries, one per dimension below
    { "dimension": "subject_line",            "score": 0-10, "rationale": "..." },
    { "dimension": "opener_personalization",  "score": 0-10, "rationale": "..." },
    { "dimension": "value_clarity",           "score": 0-10, "rationale": "..." },
    { "dimension": "social_proof",            "score": 0-10, "rationale": "..." },
    { "dimension": "cta_strength",            "score": 0-10, "rationale": "..." },
    { "dimension": "sequencing",              "score": 0-10, "rationale": "..." }
  ],
  "worst_email_index": integer | null,   // 0-based; null if a single email
  "rewrite_preview": {                    // only the worst email
    "subject": "...",
    "body": "...",
    "changed_phrases": ["original → new", ...]
  } | null,                               // null if is_real_cold_email is false
  "share_caption": "..."                  // <=200 chars, social-share-ready
}

RULES:
1. REFUSE if the input is: a marketing newsletter, a product announcement, a
   transactional email, a job-application cover letter, or obviously generated
   by ChatGPT with no specifics (only platitudes). Set is_real_cold_email=false
   and explain in refusal_reason. Do NOT score refused inputs (use zeros).
2. SCORES are integers 0-10. Calibrate against B2B SaaS-to-SaaS norms. Reserve 9-10
   for sequences you'd genuinely expect a 5%+ reply rate from.
3. OVERALL SCORE is roughly the sum of per_dimension * 100/60, but you may tilt
   ±5 based on holistic quality. Round to integer 0-100.
4. NEVER invent claims about the sender's product. The rewrite_preview must only
   use facts present in the input. If the input is too thin to rewrite, set
   rewrite_preview to null and lower value_clarity accordingly.
5. SHARE CAPTION should be self-deprecating and shareable — e.g.,
   "Got an F on my cold email. Brutal. — Copywriting Bot".
6. RETURN ONLY the JSON object — no prose, no markdown, no commentary.`;

export type RoastInput = {
  sequence: string;
  /** Optional context: where the user pasted from (e.g., "lemlist export"). */
  source?: string;
};

export type RoastOutcome =
  | { ok: true; result: RoastResultT; usage: { input: number; output: number; cacheHit: boolean } | null }
  | { ok: false; error: string };

export async function runRoastAgent(input: RoastInput): Promise<RoastOutcome> {
  addBreadcrumb("roast.start", { length: input.sequence.length, source: input.source });

  const userMessage = [
    input.source ? `Source: ${input.source}` : null,
    "Sequence (verbatim):",
    "---",
    input.sequence.trim(),
    "---",
    "Return the JSON object now.",
  ]
    .filter(Boolean)
    .join("\n");

  let raw = "";
  let usage = null;
  try {
    const res = await callJsonAgent({
      tier: "fast",
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      maxTokens: 1_500,
    });
    raw = res.raw;
    usage = res.usage;
  } catch (err) {
    captureException(err, { agent: "roast", phase: "llm_call" });
    return { ok: false, error: "Roast Agent could not reach the model. Try again." };
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    captureException(err, { agent: "roast", phase: "json_parse", raw });
    return { ok: false, error: "Roast Agent produced unparseable output." };
  }

  const validated = RoastResult.safeParse(parsed);
  if (!validated.success) {
    captureException(new Error("RoastResult schema mismatch"), {
      agent: "roast",
      phase: "schema",
      issues: validated.error.issues,
    });
    return { ok: false, error: "Roast Agent output did not match expected schema." };
  }

  return {
    ok: true,
    result: validated.data,
    usage: usage
      ? {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          // SDK exposes cache_read_input_tokens on newer versions; tolerate either.
          cacheHit:
            ((usage as unknown as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0) > 0,
        }
      : null,
  };
}
