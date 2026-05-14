import { BrandVoiceProfile, type BrandVoiceProfileT } from "@copywriting-bot/shared/schemas";
import { addBreadcrumb, captureException } from "@copywriting-bot/shared/observability";
import { callJsonAgent, extractJsonObject } from "../client.js";

/**
 * Brand Voice Scraper — given a customer URL, extract a voice profile.
 *
 * In MVP we operate on a pre-fetched HTML string (the caller fetches; this
 * keeps the agent code testable and free of fetch concerns). Phase 2 will
 * add a multi-page crawl. Model: Haiku.
 */

const SYSTEM_PROMPT = `You are the Brand Voice Scraper. Given the raw textual
content of a B2B SaaS company's homepage (and optionally additional pages),
extract a voice profile that the Rewrite Agent can use to keep cold emails
on-brand.

OUTPUT a single JSON object:

{
  "tone": ["plainspoken", "technical", ...],   // 1-8 descriptors
  "positioning": "...",                         // <=500 chars, one sentence
  "key_phrases": ["...", ...],                  // <=20, copy verbatim where possible
  "avoid_phrases": ["...", ...],                // <=20; cliches the brand never uses
  "reading_level": "accessible" | "professional" | "technical",
  "source_urls": ["https://..."]
}

RULES:
1. Use only language that appears in the supplied content. Never invent
   positioning. If the page is too thin or generic, return a low-confidence
   profile with empty key_phrases rather than guessing.
2. 'avoid_phrases' is for cliches absent from the brand voice — derive these
   from explicit anti-patterns when the brand mentions them, otherwise leave
   empty.
3. RETURN ONLY the JSON.`;

export type BrandVoiceInput = {
  url: string;
  /** Raw text content of the page(s). Caller is responsible for fetching. */
  content: string;
};

export type BrandVoiceOutcome =
  | { ok: true; result: BrandVoiceProfileT }
  | { ok: false; error: string };

export async function runBrandVoiceAgent(input: BrandVoiceInput): Promise<BrandVoiceOutcome> {
  if (!input.content || input.content.trim().length < 100) {
    return { ok: false, error: "Not enough content scraped to derive a brand voice." };
  }
  addBreadcrumb("brand_voice.start", { url: input.url, len: input.content.length });

  const userMessage = `URL: ${input.url}\n\nContent:\n${input.content.slice(0, 15_000)}`;

  let raw = "";
  try {
    const res = await callJsonAgent({
      tier: "fast",
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      maxTokens: 1_200,
    });
    raw = res.raw;
  } catch (err) {
    captureException(err, { agent: "brand_voice", phase: "llm_call" });
    return { ok: false, error: "Brand Voice Scraper could not reach the model." };
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    captureException(err, { agent: "brand_voice", phase: "json_parse", raw });
    return { ok: false, error: "Brand Voice Scraper produced unparseable output." };
  }

  const validated = BrandVoiceProfile.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, error: "Brand voice output did not match expected schema." };
  }
  return { ok: true, result: validated.data };
}
