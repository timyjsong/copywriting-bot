import { z } from "zod";

/**
 * Centralised, validated environment access.
 *
 * Server code imports `serverEnv` (throws if required keys are missing).
 * Client code imports `publicEnv` (only NEXT_PUBLIC_* exposed).
 *
 * Validation is lazy — first access triggers parse — so importing this module
 * at build time on a machine without secrets does not crash.
 */

const trueish = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY required"),
  ANTHROPIC_MODEL_PLANNING: z.string().default("claude-opus-4-7"),
  ANTHROPIC_MODEL_DEVELOPMENT: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),

  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().url().optional(),

  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_ID_FULL_REWRITE: z.string().min(1).optional(),

  INNGEST_EVENT_KEY: z.string().min(1).optional(),
  INNGEST_SIGNING_KEY: z.string().min(1).optional(),
  INNGEST_DEV: trueish,

  POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
  POSTMARK_FROM_ADDRESS: z.string().email().optional(),

  SMARTLEAD_API_KEY: z.string().min(1).optional(),
  SMARTLEAD_BASE_URL: z.string().url().default("https://server.smartlead.ai/api/v1"),

  APOLLO_API_KEY: z.string().min(1).optional(),

  SENTRY_DSN: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),

  POSTHOG_SERVER_KEY: z.string().optional(),

  OPERATOR_EMAIL: z.string().email().optional(),
  APPROVAL_GATES_DEFAULT_ON: trueish,
});

const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_OPS_URL: z.string().url().default("http://localhost:3001"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;

let _serverEnv: ServerEnv | undefined;
let _publicEnv: PublicEnv | undefined;

export function serverEnv(): ServerEnv {
  if (_serverEnv) return _serverEnv;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  _serverEnv = parsed.data;
  return _serverEnv;
}

export function publicEnv(): PublicEnv {
  if (_publicEnv) return _publicEnv;
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_OPS_URL: process.env.NEXT_PUBLIC_OPS_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid public environment:\n${issues}`);
  }
  _publicEnv = parsed.data;
  return _publicEnv;
}

/** Test-only: reset memoised envs so a new process.env can be parsed. */
export function __resetEnvForTests(): void {
  _serverEnv = undefined;
  _publicEnv = undefined;
}
