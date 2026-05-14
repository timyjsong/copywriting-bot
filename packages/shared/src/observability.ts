/**
 * Observability wiring shared across apps + packages.
 *
 * Sentry is configured via `@sentry/nextjs` sentry.{client,server,edge}.config.ts
 * inside each app. This module exposes thin helpers so non-app code (packages/agents,
 * packages/inngest) can capture errors + events without each importing Sentry directly.
 *
 * PostHog is split into a client singleton (browser) and a server client (Node).
 */

import * as Sentry from "@sentry/nextjs";
import { PostHog } from "posthog-node";

export type ObservabilityContext = {
  customerId?: string;
  agent?: string;
  phase?: string;
  [key: string]: unknown;
};

export function captureException(err: unknown, ctx: ObservabilityContext = {}): void {
  try {
    Sentry.withScope((scope) => {
      Object.entries(ctx).forEach(([k, v]) => scope.setTag(k, String(v)));
      Sentry.captureException(err);
    });
  } catch {
    // Sentry not configured (dev / test) — swallow.
  }
  // Always log; Sentry can drop, logs cannot.
  // eslint-disable-next-line no-console
  console.error("[copywriting-bot]", err, ctx);
}

export function addBreadcrumb(message: string, data: Record<string, unknown> = {}): void {
  try {
    Sentry.addBreadcrumb({ category: "agent", message, data, level: "info" });
  } catch {
    /* noop */
  }
}

let _serverPosthog: PostHog | null | undefined;

export function serverPosthog(): PostHog | null {
  if (_serverPosthog !== undefined) return _serverPosthog;
  const key = process.env.POSTHOG_SERVER_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    _serverPosthog = null;
    return null;
  }
  _serverPosthog = new PostHog(key, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
  return _serverPosthog;
}

export type FunnelEvent =
  | "visited_landing"
  | "started_roast"
  | "submitted_email"
  | "viewed_result"
  | "clicked_upsell"
  | "started_checkout"
  | "completed_checkout"
  | "onboarding_started"
  | "onboarding_step_completed"
  | "onboarding_completed"
  | "rewrite_approved"
  | "sequence_activated"
  | "performance_report_sent";

/**
 * Server-side capture of a funnel event. Safe to call without a PostHog key —
 * becomes a noop. Always include a distinctId (email, customer_id, or anonymous
 * cookie value) so funnels stitch.
 */
export async function captureServerEvent(
  distinctId: string,
  event: FunnelEvent,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const ph = serverPosthog();
  if (!ph) return;
  ph.capture({ distinctId, event, properties });
  await ph.flush();
}

/** Convenience for hot paths where we just want a fire-and-forget. */
export function track(distinctId: string, event: FunnelEvent, properties: Record<string, unknown> = {}): void {
  const ph = serverPosthog();
  if (!ph) return;
  ph.capture({ distinctId, event, properties });
}
