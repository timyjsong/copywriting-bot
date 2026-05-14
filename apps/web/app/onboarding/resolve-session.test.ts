import { describe, expect, it, vi } from "vitest";
import { resolveCheckoutSession } from "./resolve-session.js";

/**
 * Tests the retry/abort/error contract for the onboarding page's
 * resolve-checkout-session loop. Covers boundary cases the previous
 * inline implementation missed:
 *  - max-attempts exhaustion with `pending: true` surfaces an explicit error
 *  - abort during in-flight fetch returns `{ kind: "aborted" }`
 *  - abort during sleep returns `{ kind: "aborted" }` without re-fetching
 *  - non-JSON response surfaces the HTTP status, not a silent JSON-parse throw
 *  - fetch network error surfaces a readable message
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nonJsonResponse(text: string, status = 502): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function syncSleep(): (ms: number, signal?: AbortSignal) => Promise<void> {
  return (_ms, signal) => {
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    return Promise.resolve();
  };
}

describe("resolveCheckoutSession", () => {
  it("resolves immediately when the first call returns customer_id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ customer_id: "c1" }));
    const sleep = vi.fn(syncSleep());
    const out = await resolveCheckoutSession("cs_test", { fetch: fetchMock as unknown as typeof fetch, sleep });
    expect(out).toEqual({ kind: "ok", customer_id: "c1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries while body.pending is true and resolves once a customer_id appears", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pending: true }))
      .mockResolvedValueOnce(jsonResponse({ pending: true }))
      .mockResolvedValueOnce(jsonResponse({ customer_id: "c2" }));
    const sleep = vi.fn(syncSleep());
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      retryDelayMs: 10,
    });
    expect(out).toEqual({ kind: "ok", customer_id: "c2" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("surfaces an explicit error when max attempts are exhausted while still pending", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ pending: true })));
    const sleep = vi.fn(syncSleep());
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
      maxAttempts: 4,
      retryDelayMs: 1,
    });
    expect(out.kind).toBe("error");
    if (out.kind !== "error") throw new Error("type narrow failed");
    expect(out.message).toMatch(/4 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // Sleep happens between attempts, so attempts-1 times.
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("returns body.error when the server surfaces a non-pending error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: "session expired" }, 410));
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: syncSleep(),
    });
    expect(out).toEqual({ kind: "error", message: "session expired" });
  });

  it("surfaces a readable error when the response body is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(nonJsonResponse("<html>502</html>", 502));
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: syncSleep(),
    });
    expect(out.kind).toBe("error");
    if (out.kind !== "error") throw new Error("type narrow failed");
    expect(out.message).toMatch(/HTTP 502/);
  });

  it("surfaces fetch network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: syncSleep(),
    });
    expect(out).toEqual({ kind: "error", message: "network down" });
  });

  it("returns kind=aborted when signal is aborted before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: syncSleep(),
      signal: controller.signal,
    });
    expect(out).toEqual({ kind: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns kind=aborted when fetch rejects due to abort", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: syncSleep(),
      signal: controller.signal,
    });
    expect(out).toEqual({ kind: "aborted" });
  });

  it("returns kind=aborted when sleep is aborted mid-retry (no further fetch)", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ pending: true }));
    const sleep = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const out = await resolveCheckoutSession("cs_test", {
      fetch: fetchMock as unknown as typeof fetch,
      sleep: sleep as unknown as ResolveSleep,
      signal: controller.signal,
      maxAttempts: 4,
    });
    expect(out).toEqual({ kind: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

type ResolveSleep = (ms: number, signal?: AbortSignal) => Promise<void>;
