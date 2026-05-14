import { EventSchemas, Inngest, type GetEvents } from "inngest";
import { z } from "zod";

/**
 * Inngest client + typed event registry.
 *
 * Every event our system emits is declared here so functions can subscribe
 * with full type-safety. PRD §5.2 — durable functions with operator approval
 * gates use `step.waitForEvent("operator.approval", { match: "data.id" })`.
 */

export const events = {
  "stripe/checkout.completed": {
    data: z.object({
      stripe_session_id: z.string(),
      stripe_customer_id: z.string().nullable(),
      customer_email: z.string().email(),
      amount_total: z.number().int(),
      currency: z.string(),
      created_customer_id: z.string().uuid(),
    }),
  },
  "roast/submitted": {
    data: z.object({
      roast_id: z.string().uuid(),
      email: z.string().email(),
      source: z.string().optional(),
    }),
  },
  "onboarding/completed": {
    data: z.object({
      customer_id: z.string().uuid(),
      sequence_id: z.string().uuid(),
    }),
  },
  "rewrite/requested": {
    data: z.object({
      customer_id: z.string().uuid(),
      sequence_id: z.string().uuid(),
    }),
  },
  "operator.approval": {
    // Generic approval event matched on data.id in step.waitForEvent.
    data: z.object({
      id: z.string().uuid(), // approvals_queue.id
      decision: z.enum(["approve", "reject", "edit_and_approve"]),
      decided_by: z.string().email().optional(),
      edited_payload: z.record(z.string(), z.unknown()).optional(),
      notes: z.string().optional(),
    }),
  },
  "send_batch/generate": {
    data: z.object({
      campaign_id: z.string().uuid(),
      batch_date: z.string(),
    }),
  },
  "performance/daily_pull": {
    data: z.object({
      campaign_id: z.string().uuid(),
    }),
  },
  "outbound/daily_source": {
    data: z.object({
      target_count: z.number().int().min(1).max(500),
    }),
  },
  "support/inbound": {
    data: z.object({
      customer_email: z.string().email(),
      subject: z.string(),
      body: z.string(),
      recent_thread: z.string().default(""),
      twenty_one_day_metric_missed: z.boolean().default(false),
    }),
  },
  "refund/requested": {
    data: z.object({
      customer_id: z.string().uuid(),
      stripe_charge_id: z.string(),
      amount: z.number().int(),
      currency: z.string(),
      reason: z.string().default(""),
    }),
  },
  "rewrite/approved": {
    data: z.object({
      customer_id: z.string().uuid(),
      sequence_id: z.string().uuid(),
    }),
  },
} as const;

const schemas = new EventSchemas().fromZod(events);

export const inngest = new Inngest({
  id: "copywriting-bot",
  schemas,
});

export type Events = GetEvents<typeof inngest>;
