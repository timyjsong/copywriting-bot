import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@copywriting-bot/shared/env";

/**
 * Supabase client factories.
 *
 * - `serviceClient()` uses the service role key — bypasses RLS — for trusted
 *   server-side code (route handlers, Inngest functions, agents).
 * - `anonClient()` uses the anon key — RLS enforced — for code paths where a
 *   user JWT can be attached (e.g., dashboards reading their own data).
 *
 * Both clients are singletons per process. Reset between tests via
 * `__resetClientsForTests()`.
 *
 * NOTE: We deliberately don't pass a `<Database>` generic here. supabase-js
 * v2.105 made the generic far stricter and the auto-generated `Database`
 * type from `supabase gen types` is the only one it accepts cleanly. For MVP
 * we validate inputs/outputs at the boundary with zod (see packages/shared
 * schemas), which gives us safety without locking ourselves into a generated
 * type loop. Phase 2 will swap in the generated type.
 */

let _service: SupabaseClient | undefined;
let _anon: SupabaseClient | undefined;

export function serviceClient(): SupabaseClient {
  if (_service) return _service;
  const pub = publicEnv();
  const env = serverEnv();
  _service = createClient(pub.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _service;
}

export function anonClient(): SupabaseClient {
  if (_anon) return _anon;
  const pub = publicEnv();
  _anon = createClient(pub.NEXT_PUBLIC_SUPABASE_URL, pub.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _anon;
}

export function __resetClientsForTests(): void {
  _service = undefined;
  _anon = undefined;
}
