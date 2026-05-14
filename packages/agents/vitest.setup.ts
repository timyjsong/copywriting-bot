/**
 * Default test-time env vars. Individual tests override what they care about
 * (e.g. smartlead.test.ts swaps SMARTLEAD_BASE_URL); these defaults just keep
 * the shared env loader from refusing to parse.
 */
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-supabase-key";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SMARTLEAD_API_KEY = "test-smartlead-key";
process.env.SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";
