import { captureServerEvent, type FunnelEvent } from "@copywriting-bot/shared/observability";

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
 */
export async function emitFunnelEvent(
  step: FunnelStep,
  stepId: string,
  customerId: string,
  eventName: FunnelEvent,
  props: Record<string, unknown>,
): Promise<void> {
  await step.run(stepId, async () => {
    await captureServerEvent(customerId, eventName, props);
  });
}
