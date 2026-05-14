/**
 * Zero-dependency module: funnel event type + dedup-key builder.
 *
 * Kept separate from `observability.ts` so client-side React components can
 * import `funnelInsertId` without dragging `posthog-node` into the browser
 * bundle (posthog-node uses `node:readline` and friends and crashes the
 * webpack build when pulled into a Client Component).
 *
 * The runtime emit primitives (`captureServerEvent`, `emitFunnelEventBestEffort`)
 * still live in `observability.ts` / `funnel.ts` — only the *literal format*
 * of `$insert_id` lives here, because that format must be identical between
 * client (posthog-js) and server (posthog-node) callers.
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
  | "onboarding_completed"
  | "rewrite_approved"
  | "sequence_activated"
  | "performance_report_sent";

/**
 * Build a PostHog `$insert_id` for a funnel event. Returned value is the
 * dedup token PostHog uses to drop duplicate events (24h dedup window per
 * distinct_id + event + $insert_id).
 *
 * Why this is a function, not a literal at each call site: `viewed_result`
 * and `onboarding_completed` are emitted from BOTH the client (immediate
 * intent) AND the server (post-persistence guarantee) so the funnel still
 * lands when posthog-js is blocked. The two emissions must share a stable,
 * identical insert_id — a single-character drift here silently doubles
 * conversion counts. Centralising the format kills that whole class of bug.
 *
 * The prefix `${event}:` namespaces the key so two different events that
 * happen to share an underlying ID (e.g. `roast_id` reused across future
 * `shared_roast` + `viewed_result`) can't collide.
 */
export function funnelInsertId(event: FunnelEvent, key: string): string {
  return `${event}:${key}`;
}
