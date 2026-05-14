"use client";

import posthog from "posthog-js";
// Import from the zero-deps subpath so this Client Component doesn't drag
// posthog-node (Node-only) into the browser bundle via observability.ts.
import type { FunnelEvent } from "@copywriting-bot/shared/funnel-keys";

/**
 * Client-side funnel event helpers. `FunnelEvent` is imported (not redeclared)
 * from @copywriting-bot/shared so the server + client always agree on the set
 * of legal event names — a previous duplication silently allowed drift.
 */

export type { FunnelEvent };

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
