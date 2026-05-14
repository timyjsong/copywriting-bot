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
      const maybe = Sentry.captureException(err) as unknown;
      // Some Sentry transports return a thenable. The sync try/catch wouldn't
      // see a later rejection — suppress it so this helper truly never escapes
      // a failure (unhandled-rejection pollution would otherwise leak out).
      if (maybe && typeof (maybe as { then?: unknown }).then === "function") {
        (maybe as Promise<unknown>).catch(() => {});
      }
    });
  } catch {
    // Sentry not configured (dev / test) — swallow.
  }
  try {
    // Always log; Sentry can drop, logs cannot.
    // eslint-disable-next-line no-console
    console.error("[copywriting-bot]", err, ctx);
  } catch {
    // stderr broken — last resort, nothing left to do. The contract is "never
    // throw", and a downstream catch-everything in the safe variant relies on
    // it. See safe-capture.test.ts "last-resort" cases.
  }
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
 *
 * Throws propagate. Use inside Inngest `step.run` so step-level retries fire
 * on transient PostHog failures. For HTTP route hot paths use
 * `captureServerEventSafe` — a dropped funnel event must never fail a
 * user-facing request.
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

/**
 * HTTP-route-safe wrapper around `captureServerEvent`. Catches any throw
 * (PostHog 5xx, network blip, malformed init) and reports it to Sentry
 * rather than failing the request. Use in Next.js route handlers; use the
 * unsafe variant in Inngest steps so retries kick in.
 */
export async function captureServerEventSafe(
  distinctId: string,
  event: FunnelEvent,
  properties: Record<string, unknown> = {},
): Promise<void> {
  try {
    await captureServerEvent(distinctId, event, properties);
  } catch (err) {
    try {
      captureException(err, { agent: "posthog", event });
    } catch {
      // Sentry itself is down — the contract is "never throw" so we swallow
      // here too. Last-resort log so the failure is at least visible in
      // server output.
      // eslint-disable-next-line no-console
      console.error("[copywriting-bot] captureServerEventSafe: Sentry capture failed", err);
    }
  }
}

/** Convenience for hot paths where we just want a fire-and-forget. */
export function track(distinctId: string, event: FunnelEvent, properties: Record<string, unknown> = {}): void {
  const ph = serverPosthog();
  if (!ph) return;
  ph.capture({ distinctId, event, properties });
}

/**
 * Route-handler primitive for "emit a funnel event after success-defining work,
 * but never let it fail the user's request." Composes the bulletproofed
 * `captureServerEventSafe` and `captureException` primitives so callers stop
 * re-implementing the policy at every site. Iter 17 had this pattern duplicated
 * in two routes; iter 18 collapses it here.
 *
 * Contract: never throws. Telemetry is gravy; the user's 200 is sacred.
 *
 * The `phase` tag (e.g. `"roast_funnel_emission"`) becomes a Sentry scope tag
 * so dropped events are correlatable to the call site.
 */
export async function emitFunnelEventBestEffort(
  distinctId: string,
  event: FunnelEvent,
  properties: Record<string, unknown>,
  ctx: { phase: string },
): Promise<void> {
  try {
    await captureServerEventSafe(distinctId, event, properties);
  } catch (err) {
    // captureServerEventSafe is documented to never throw, but it composes the
    // deeper captureException primitive. If a future change ever lets it
    // escape, captureException is itself bulletproofed (its outer try/catch
    // swallows Sentry-down + stderr-down), so this single call is the entire
    // last-resort layer. No nested try/catch needed.
    captureException(err, { phase: ctx.phase });
  }
}
