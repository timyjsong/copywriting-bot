import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the `roastSubmitted` Inngest function's pure runner.
 *
 * The function fires post-API to send the result email + emit `viewed_result`
 * to PostHog server-side as belt-and-suspenders for the client-side emission
 * in `apps/web/app/roast/page.tsx`. The two emissions MUST share a stable
 * `$insert_id` so PostHog dedupes them — otherwise the funnel double-counts
 * every successful roast, inflating the conversion rate from `submitted_email`
 * → `viewed_result` for every paying-customer cohort.
 *
 * Pin the contract:
 *   1. `viewed_result` is emitted exactly once via `captureServerEvent`.
 *   2. The payload contains `$insert_id: "viewed_result:<roast_id>"`. This
 *      key shape is the dedup contract; a regression that drops the prefix
 *      or keys on something non-stable (Date.now(), uuid()) would silently
 *      reintroduce double-counting and is hard to spot in PostHog.
 *   3. The `leads` upsert runs in its own step (idempotency boundary).
 */

const { captureServerEventMock } = vi.hoisted(() => ({
  captureServerEventMock: vi.fn(async () => undefined),
}));

vi.mock("@copywriting-bot/shared/observability", () => ({
  captureServerEvent: captureServerEventMock,
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  // Use the real helper so the test pins the actual format produced in prod,
  // not a mock that could drift. The format is itself locked by funnel.test.ts.
  funnelInsertId: (event: string, key: string) => `${event}:${key}`,
}));

vi.mock("@copywriting-bot/db/client", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn(() => ({ upsert: vi.fn(async () => ({ data: null, error: null })) })),
  })),
}));

import { runRoastSubmitted } from "./roast.js";

type StepRunCall = { id: string };

function makeStep() {
  const calls: StepRunCall[] = [];
  return {
    calls,
    step: {
      run: vi.fn(async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
        calls.push({ id });
        return fn();
      }),
    },
  };
}

function makeDbFake() {
  const upsertCalls: Array<{ table: string; values: unknown; opts: unknown }> = [];
  const db = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn(async (values: unknown, opts: unknown) => {
        upsertCalls.push({ table, values, opts });
        return { data: null, error: null };
      }),
    })),
  };
  return { db, upsertCalls };
}

describe("runRoastSubmitted — viewed_result funnel emission", () => {
  beforeEach(() => {
    captureServerEventMock.mockReset();
    captureServerEventMock.mockImplementation(async () => undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it("emits viewed_result with $insert_id keyed on roast_id (dedup contract with client)", async () => {
    const { step, calls } = makeStep();
    const { db } = makeDbFake();

    await runRoastSubmitted({
      event: { data: { roast_id: "roast-abc", email: "user@example.com", source: "web" } },
      step: step as never,
      db: db as never,
    });

    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "user@example.com",
      "viewed_result",
      {
        roast_id: "roast-abc",
        source: "web",
        // Hard-pin the dedup key shape. A regression that uses Date.now() /
        // crypto.randomUUID() here would silently double-count completions
        // in PostHog because the matching client emission keys on roast_id.
        $insert_id: "viewed_result:roast-abc",
      },
    );
    expect(calls.map((c) => c.id)).toEqual(["upsert-lead", "track-funnel"]);
  });

  it("passes source:null through unchanged when caller omits it (no surprise '' or 'unknown' substitution)", async () => {
    const { step } = makeStep();
    const { db } = makeDbFake();

    await runRoastSubmitted({
      event: { data: { roast_id: "roast-xyz", email: "lead@acme.test" } },
      step: step as never,
      db: db as never,
    });

    expect(captureServerEventMock).toHaveBeenCalledWith(
      "lead@acme.test",
      "viewed_result",
      {
        roast_id: "roast-xyz",
        source: null,
        $insert_id: "viewed_result:roast-xyz",
      },
    );
  });

  it("upserts the lead row on the email conflict key before emitting the funnel event", async () => {
    const { step, calls } = makeStep();
    const { db, upsertCalls } = makeDbFake();

    await runRoastSubmitted({
      event: { data: { roast_id: "roast-1", email: "x@y.test", source: "ref" } },
      step: step as never,
      db: db as never,
    });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toEqual({
      table: "leads",
      values: { email: "x@y.test", source: "ref", first_roast_id: "roast-1" },
      opts: { onConflict: "email" },
    });
    // Ordering matters: lead must exist before the funnel event so PostHog's
    // distinct_id (email) already correlates with a persisted lead row.
    expect(calls.map((c) => c.id)).toEqual(["upsert-lead", "track-funnel"]);
  });

  it("propagates if captureServerEvent throws so Inngest retries the step (no silent swallow)", async () => {
    captureServerEventMock.mockRejectedValueOnce(new Error("posthog 503"));
    const { step } = makeStep();
    const { db } = makeDbFake();

    await expect(
      runRoastSubmitted({
        event: { data: { roast_id: "roast-2", email: "fail@a.test", source: null } },
        step: step as never,
        db: db as never,
      }),
    ).rejects.toThrow(/posthog 503/);
    // Step-level retry boundary: this is exactly why we use captureServerEvent
    // (not the *Safe variant) inside Inngest steps per observability.ts docs.
  });

  it("$insert_id format stays prefixed with the event name to avoid cross-event collisions", async () => {
    const { step } = makeStep();
    const { db } = makeDbFake();

    await runRoastSubmitted({
      event: { data: { roast_id: "shared-id", email: "x@y.test", source: null } },
      step: step as never,
      db: db as never,
    });

    const call = captureServerEventMock.mock.calls[0] as unknown as [
      string,
      string,
      { $insert_id: string },
    ];
    const props = call[2];
    // If a future change keyed `$insert_id` as just `roast_id` without the
    // `viewed_result:` prefix, a hypothetical future event that also keys on
    // `roast_id` (e.g. `shared_roast`) could collide and silently drop the
    // second event. The prefix is the namespace.
    expect(props.$insert_id.startsWith("viewed_result:")).toBe(true);
    expect(props.$insert_id).toBe("viewed_result:shared-id");
  });

  it("falls back to serviceClient() when ctx.db is omitted (iter-21 review #6 / #9 — production wrapper path)", async () => {
    // The Inngest wrapper at roast.ts:54-59 doesn't pass `db`; production
    // hits `ctx.db ?? serviceClient()`. Every other test injects a fake db,
    // leaving the fallback path uncovered. Mock the import once so we can
    // verify it's called when ctx.db is undefined.
    const upsertMock = vi.fn(async () => ({ data: null, error: null }));
    const fromMock = vi.fn(() => ({ upsert: upsertMock }));
    const { serviceClient } = await import("@copywriting-bot/db/client");
    (serviceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      from: fromMock,
    });

    const { step } = makeStep();
    await runRoastSubmitted({
      event: { data: { roast_id: "roast-fb", email: "fb@a.test", source: "web" } },
      step: step as never,
      // No `db` field — must hit the fallback.
    });

    expect(serviceClient).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith("leads");
    expect(upsertMock).toHaveBeenCalledTimes(1);
    // Funnel emit still lands when the fallback path is taken — no regression
    // where the fallback skips the second step.
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "fb@a.test",
      "viewed_result",
      expect.objectContaining({ $insert_id: "viewed_result:roast-fb" }),
    );
  });
});

describe("runRoastSubmitted — leads upsert error envelope (iter-21 review #5 / #10)", () => {
  /**
   * Production code at `roast.ts:32-35` calls
   * `db.from("leads").upsert(...)` and does NOT inspect the returned
   * `{ data, error }` envelope. That is INTENTIONAL today — the funnel
   * emission is more important than the lead row landing, and Supabase's
   * upsert rarely returns transient errors. But the contract is unverified:
   * a future change that adds `if (error) throw` (good!) or one that removes
   * the upsert entirely (bad!) would silently pass every other test.
   *
   * These tests pin the CURRENT contract: upsert errors are swallowed at the
   * step boundary, the funnel emit still runs. A regression in either
   * direction is now visible.
   */

  beforeEach(() => {
    captureServerEventMock.mockReset();
    captureServerEventMock.mockImplementation(async () => undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it("does NOT throw when leads.upsert returns an error envelope — funnel emit still runs (CURRENT contract)", async () => {
    const { step, calls } = makeStep();
    const upsertCalls: Array<unknown> = [];
    const db = {
      from: vi.fn(() => ({
        upsert: vi.fn(async (values: unknown) => {
          upsertCalls.push(values);
          // Surface the failure that production currently swallows.
          return { data: null, error: { message: "duplicate key value violates unique constraint" } };
        }),
      })),
    };

    await runRoastSubmitted({
      event: { data: { roast_id: "roast-err", email: "err@a.test", source: "web" } },
      step: step as never,
      db: db as never,
    });

    expect(upsertCalls).toHaveLength(1);
    // Both steps ran — the error envelope did not abort the function.
    expect(calls.map((c) => c.id)).toEqual(["upsert-lead", "track-funnel"]);
    // Funnel emit fires regardless of the upsert outcome.
    expect(captureServerEventMock).toHaveBeenCalledTimes(1);
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "err@a.test",
      "viewed_result",
      expect.objectContaining({ $insert_id: "viewed_result:roast-err" }),
    );
  });

  it("propagates if the upsert call ITSELF throws (vs returning an error envelope) — Inngest will retry", async () => {
    // Different failure mode: the Supabase client throws instead of returning
    // `{ error }`. That IS a step-level retry trigger because nothing in
    // production catches it. Pinning the asymmetry: thrown ≠ error-envelope.
    const { step } = makeStep();
    const db = {
      from: vi.fn(() => ({
        upsert: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      })),
    };

    await expect(
      runRoastSubmitted({
        event: { data: { roast_id: "roast-throw", email: "t@a.test", source: null } },
        step: step as never,
        db: db as never,
      }),
    ).rejects.toThrow(/connection refused/);

    // The funnel step never ran — upsert step threw and aborted.
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});
