import {
  captureServerEvent,
  funnelInsertId,
  type FunnelEvent,
} from "@copywriting-bot/shared/observability";

/**
 * Minimal `step` surface used by funnel emission. Local to this module so
 * callers don't have to thread the full Inngest step type just to emit.
 */
export type FunnelStep = {
  run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T>;
};

/**
 * Emit a PostHog funnel event inside a durable `step.run` wrapper.
 *
 * Centralised so funnel-event semantics evolve in one place (e.g. session_id
 * propagation, common props). Step IDs are unique-per-function — pass the
 * full ID (including any per-entity suffix) rather than a prefix.
 *
 * Throws from `captureServerEvent` propagate up so Inngest retries the step
 * — never swallow funnel-emit failures, since dropped events corrupt the
 * conversion funnel for that customer permanently.
 *
 * `dedupKey` — when set, the helper stamps a PostHog `$insert_id` keyed on
 * `funnelInsertId(eventName, dedupKey)` so a retried step (e.g. transient
 * PostHog 5xx) collapses on PostHog's 24h dedup window instead of double-
 * counting the conversion. Pass a stable per-entity identifier (approval_id,
 * batch_id, `${campaign_id}:${snapshot_date}`, etc.) so the same logical
 * emission always produces the same key. Omit (the default) for events whose
 * step has no retry surface — preserves the existing reference-equality
 * contract on `props` for those callers.
 */
export async function emitFunnelEvent(
  step: FunnelStep,
  stepId: string,
  customerId: string,
  eventName: FunnelEvent,
  props: Record<string, unknown>,
  dedupKey?: string,
): Promise<void> {
  await step.run(stepId, async () => {
    const finalProps =
      dedupKey !== undefined
        ? { ...props, $insert_id: funnelInsertId(eventName, dedupKey) }
        : props;
    await captureServerEvent(customerId, eventName, finalProps);
  });
}
