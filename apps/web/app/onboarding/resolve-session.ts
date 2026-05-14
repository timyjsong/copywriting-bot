/**
 * Pure, testable resolve-checkout-session loop. The onboarding page calls
 * this with a real fetch + setTimeout-based sleep; tests inject deterministic
 * stubs.
 *
 * Behaviour:
 *  - Up to `maxAttempts` (default 12) calls to /api/checkout/resolve.
 *  - When the response includes `pending: true`, sleep and retry until the
 *    cap is hit; then surface an explicit error (the previous implementation
 *    silently dropped the user here).
 *  - When `customer_id` is returned, resolve with `kind: "ok"`.
 *  - Network errors, non-JSON bodies, and explicit `error` strings all
 *    resolve with `kind: "error"` carrying a user-readable message.
 *  - An optional `AbortSignal` short-circuits the loop and cancels the
 *    pending sleep so unmount doesn't leak timers.
 */

export type ResolveResult =
  | { kind: "ok"; customer_id: string }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

export type ResolveDeps = {
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
};

type ResolveBody = { customer_id?: string; pending?: boolean; error?: string };

export async function resolveCheckoutSession(
  sessionId: string,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  const maxAttempts = deps.maxAttempts ?? 12;
  const retryDelayMs = deps.retryDelayMs ?? 1500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal?.aborted) return { kind: "aborted" };

    let body: ResolveBody;
    try {
      const res = await deps.fetch("/api/checkout/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        signal: deps.signal,
      });
      try {
        body = (await res.json()) as ResolveBody;
      } catch {
        return {
          kind: "error",
          message: `Resolve failed (HTTP ${res.status} with non-JSON body)`,
        };
      }
    } catch (e: unknown) {
      if (deps.signal?.aborted) return { kind: "aborted" };
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "error", message };
    }

    if (body.customer_id) return { kind: "ok", customer_id: body.customer_id };

    if (body.pending && attempt < maxAttempts) {
      try {
        await deps.sleep(retryDelayMs, deps.signal);
      } catch {
        return { kind: "aborted" };
      }
      continue;
    }

    return {
      kind: "error",
      message:
        body.error ??
        `Could not link to your checkout session after ${attempt} attempts. Refresh in a few seconds.`,
    };
  }

  return { kind: "error", message: "Resolve loop exhausted" };
}

/** Default sleep used by the page. Honours AbortSignal so unmount cancels it. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
