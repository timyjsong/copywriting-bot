import { z } from "zod";

/**
 * Request-body schema for POST /api/checkout/resolve. Lives in its own file
 * because Next.js's route.ts only allows specific exports (HTTP methods +
 * a small set of runtime config). Imported by both the handler and its
 * tests so any drift in the contract surfaces as a type error rather than
 * silent rejection.
 */
export const ResolveCheckoutBody = z.object({
  session_id: z.string().min(8),
});

export type ResolveCheckoutBody = z.infer<typeof ResolveCheckoutBody>;
