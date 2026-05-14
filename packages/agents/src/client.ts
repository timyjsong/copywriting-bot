import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@copywriting-bot/shared/env";

/**
 * Centralised Anthropic client with prompt caching primitives.
 *
 * Why this file exists:
 *   - We want a single place that knows about model tiers (planning/development/fast).
 *   - PRD §5.4 mandates prompt caching on all system prompts; we standardise
 *     the cache_control shape so individual agents can't forget.
 *   - We surface a small "JSON-mode" helper that pairs a system prompt with a
 *     forced JSON output schema description, since every agent in this
 *     codebase returns structured JSON.
 */

let _client: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (_client) return _client;
  const env = serverEnv();
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export type ModelTier = "planning" | "development" | "fast";

export function modelFor(tier: ModelTier): string {
  const env = serverEnv();
  switch (tier) {
    case "planning":
      return env.ANTHROPIC_MODEL_PLANNING;
    case "development":
      return env.ANTHROPIC_MODEL_DEVELOPMENT;
    case "fast":
      return env.ANTHROPIC_MODEL_FAST;
  }
}

/**
 * System prompt block with caching enabled.
 * Anthropic caches the prefix that has `cache_control: { type: "ephemeral" }`
 * attached, which dramatically reduces cost on hot-path agents (Roast, Rewrite).
 */
export function cachedSystemBlock(text: string): Array<{
  type: "text";
  text: string;
  cache_control: { type: "ephemeral" };
}> {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

export type AgentInvocation<TInput> = {
  agent: string;
  tier: ModelTier;
  input: TInput;
  /** Override max tokens; defaults reasonable per agent. */
  maxTokens?: number;
  /** Operator / customer correlation id for logging. */
  correlationId?: string;
};

/**
 * Run the model in JSON-output mode.
 *
 * We don't use Anthropic's structured-output beta yet; we instead instruct the
 * model to emit a single JSON object inside a ```json``` block and parse it
 * with a tolerant extractor. Validation against a Zod schema is the caller's
 * responsibility.
 */
export async function callJsonAgent(opts: {
  tier: ModelTier;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}): Promise<{ raw: string; usage: Anthropic.Messages.Usage | null }> {
  const client = anthropic();
  const response = await client.messages.create({
    model: modelFor(opts.tier),
    max_tokens: opts.maxTokens ?? 2_000,
    system: cachedSystemBlock(opts.systemPrompt),
    messages: [{ role: "user", content: opts.userMessage }],
  });

  const text = response.content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return { raw: text, usage: response.usage ?? null };
}

/**
 * Best-effort JSON extractor. Accepts:
 *   - bare JSON
 *   - ```json ... ``` fenced
 *   - JSON preceded/followed by prose
 *
 * Throws if no parseable JSON object is found.
 */
export function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : raw;
  if (!candidate) throw new Error("Empty model response — no JSON to parse");

  const trimmed = candidate.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // Locate the outermost {...} substring as a fallback.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Model output did not contain a JSON object");
  }
  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
}
