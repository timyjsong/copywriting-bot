"use client";

import posthog from "posthog-js";

/**
 * Client-side funnel event helpers. Mirrors `FunnelEvent` in
 * @copywriting-bot/shared/observability so server + client emit the same
 * event names into the same PostHog project.
 *
 * Safe to call before PostHog has initialized — if init was skipped (no key
 * in env) the call becomes a noop and we surface a one-time console warn.
 */

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
  | "onboarding_completed";

let warned = false;

export function trackClient(event: FunnelEvent, properties: Record<string, unknown> = {}): void {
  try {
    if (!posthog || !posthog.__loaded) {
      if (!warned && typeof window !== "undefined") {
        warned = true;
        // eslint-disable-next-line no-console
        console.debug("[posthog] not initialized; skipping", event);
      }
      return;
    }
    posthog.capture(event, properties);
  } catch {
    /* noop */
  }
}

export function identifyClient(distinctId: string, traits: Record<string, unknown> = {}): void {
  try {
    if (!posthog || !posthog.__loaded) return;
    posthog.identify(distinctId, traits);
  } catch {
    /* noop */
  }
}
