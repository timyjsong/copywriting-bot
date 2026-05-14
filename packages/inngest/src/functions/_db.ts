import type { serviceClient } from "@copywriting-bot/db/client";

/**
 * Structural port for the DB client used by Inngest functions. Derived
 * from `serviceClient`'s return type so prod code keeps full Postgrest
 * chain typing, but expressed as a named port so tests can inject a fake
 * via the function signature instead of `vi.mock("@copywriting-bot/db/client")`
 * — see `test-utils/supabase-fake.ts` for the structural fake that
 * satisfies the subset of `.from(table)` shapes we actually call.
 *
 * Using `ReturnType<typeof serviceClient>` (instead of importing
 * `SupabaseClient` directly) keeps the inngest package from gaining a
 * direct dependency on `@supabase/supabase-js`.
 */
export type DbPort = ReturnType<typeof serviceClient>;
