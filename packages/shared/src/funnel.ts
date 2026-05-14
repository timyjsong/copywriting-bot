import { captureServerEventSafe, captureException } from "./observability.js";
import type { FunnelEvent } from "./funnel-keys.js";

// `funnelInsertId` moved to `./funnel-keys.ts` so client components can use
// it without pulling posthog-node into the browser bundle.
export { funnelInsertId } from "./funnel-keys.js";

/**
 * Route-handler primitive for "emit a funnel event but never let it fail the
 * user's request." Composes the bulletproofed `captureServerEventSafe` and
 * `captureException` primitives so callers stop re-implementing the policy at
 * every site. Iter 17 had this duplicated across two routes; iter 18 collapsed
 * it; iter 19 split it from observability.ts so tests can force the rare
 * outer-catch path (same-module calls can't be vi.mock'd).
 *
 * Contract: never throws. Telemetry is gravy; the user's 200 is sacred.
 *
 * Ordering convention: callers choose. The primitive name reads as "post-success"
 * but call sites pick the timing based on event semantics:
 *   - `/api/roast` emits BEFORE work (`submitted_email` is intent — counts even
 *     if the agent fails downstream).
 *   - `/api/onboarding` emits AFTER work (`onboarding_completed` is completion —
 *     only counts if the sequence row landed).
 * Both are valid; both are pinned by route-level tests.
 *
 * The `phase` tag (e.g. `"roast_funnel_emission"`) becomes a Sentry scope tag
 * IF the inner safe wrapper itself escapes — a "should-never-happen" path that
 * `captureServerEventSafe` is documented to prevent. The outer catch exists as
 * defense-in-depth so a future regression in the safe wrapper can't
 * silently 500 the user; the phase tag makes such a regression correlatable
 * to its call site.
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
    // captureServerEventSafe is documented to never throw, but it composes
    // the deeper captureException primitive. If a future change ever lets it
    // escape, captureException is itself bulletproofed (its outer try/catch
    // swallows Sentry-down + stderr-down), so this single call is the entire
    // last-resort layer. No nested try/catch needed.
    captureException(err, { phase: ctx.phase });
  }
}
