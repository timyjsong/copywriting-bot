import { expect, vi } from "vitest";
import type { DbPort } from "../functions/_db.js";

/**
 * Test-only DB + step fakes for Inngest function unit tests.
 *
 * Located in `src/test-utils/` (not `src/functions/`) so the structural
 * separation prevents an accidental production import from pulling
 * `vi` (vitest) into a runtime bundle. Vitest's `include` only matches
 * `*.test.{ts,tsx}` so this file is never collected as a test itself.
 *
 * Each table is configured up-front with what it should return for the
 * query shapes the production code uses. All write side-effects are
 * captured on the returned `recorded` object so tests can assert exactly
 * what was written.
 *
 * Supported query shapes (auto-detected by which chain methods were called):
 *
 *   - `.select().eq().single()`                         → returns `select`
 *   - `.insert(values).select().single()`               → returns `insert`
 *   - `.update(values).eq(...)`                         → returns `update`
 *   - `.upsert(values, opts)`                           → returns `upsert`
 *   - `.select("...", {count:"exact",head:true})...`    → returns `count`
 *   - `.select().in().order().range(from,to)`           → returns paged data
 *
 * Pagination is keyed by `from / pageSize` so a prod bug that re-requests
 * page 0 surfaces as a wrong-page lookup (not a silent re-emit of the same
 * data). Configure via `pages` + `pageSize`.
 */
export type TableConfig = {
  select?: { data: unknown; error?: unknown };
  insert?: { data: unknown; error?: unknown };
  /**
   * Update result. Accepts either a single object (returned for every update
   * to this table) or a function that receives the values payload and returns
   * a result — use the function form when two updates to the same table need
   * different outcomes (e.g. intermediate write succeeds but apply-decision
   * write fails).
   */
  update?:
    | { data?: unknown; error?: unknown }
    | ((values: Record<string, unknown>) => { data?: unknown; error?: unknown });
  upsert?: { data?: unknown; error?: unknown };
  count?: { count: number | null; error?: unknown };
  pages?: { pageSize: number; pages: unknown[][] };
};

export type RecordedWrite = {
  values: Record<string, unknown>;
  eqArgs: Array<[string, unknown]>;
  neqArgs: Array<[string, unknown]>;
};

export type Recorded = {
  insert: Record<string, RecordedWrite[]>;
  update: Record<string, RecordedWrite[]>;
  upsert: Record<string, RecordedWrite[]>;
  count: Record<string, Array<{ eqArgs: Array<[string, unknown]>; neqArgs: Array<[string, unknown]> }>>;
  rangeCalls: Record<string, Array<[number, number]>>;
};

export type SupabaseFake = {
  /** Returns the fake `DbPort` instance the production code can be handed. */
  db: DbPort;
  recorded: Recorded;
};

export function makeSupabaseFake(tables: Record<string, TableConfig>): SupabaseFake {
  const recorded: Recorded = {
    insert: {},
    update: {},
    upsert: {},
    count: {},
    rangeCalls: {},
  };
  for (const t of Object.keys(tables)) {
    recorded.insert[t] = [];
    recorded.update[t] = [];
    recorded.upsert[t] = [];
    recorded.count[t] = [];
    recorded.rangeCalls[t] = [];
  }

  function build(table: string): unknown {
    const cfg = tables[table] ?? {};
    let mode: "select" | "insert" | "update" | "upsert" | "count" | "range" = "select";
    let pendingValues: Record<string, unknown> | null = null;
    const eqArgs: Array<[string, unknown]> = [];
    const neqArgs: Array<[string, unknown]> = [];
    // Idempotency guard: `.then(...)` may run more than once if a test
    // accidentally awaits the same builder twice. Without this flag, every
    // re-await would re-push to `recorded.*`, silently doubling write-count
    // assertions and masking the foot-gun.
    let recorded_once = false;

    const builder: Record<string, unknown> = {};

    builder.select = vi.fn((_cols?: string, options?: { count?: string; head?: boolean }) => {
      if (options?.head && options?.count === "exact") mode = "count";
      // .select() after .insert() keeps insert mode (insert().select().single() pattern)
      return builder;
    });
    builder.insert = vi.fn((values: Record<string, unknown>) => {
      mode = "insert";
      pendingValues = values;
      return builder;
    });
    builder.update = vi.fn((values: Record<string, unknown>) => {
      mode = "update";
      pendingValues = values;
      return builder;
    });
    builder.upsert = vi.fn((values: Record<string, unknown>, _opts?: object) => {
      mode = "upsert";
      pendingValues = values;
      // upsert resolves immediately when awaited (no .then chain needed)
      return Promise.resolve(cfg.upsert ?? { data: null, error: null }).then((r) => {
        if (!recorded_once) {
          (recorded.upsert[table] ??= []).push({ values: pendingValues ?? {}, eqArgs, neqArgs });
          recorded_once = true;
        }
        return r;
      });
    });
    builder.eq = vi.fn((col: string, val: unknown) => {
      eqArgs.push([col, val]);
      return builder;
    });
    builder.neq = vi.fn((col: string, val: unknown) => {
      neqArgs.push([col, val]);
      return builder;
    });
    builder.in = vi.fn(() => builder);
    builder.order = vi.fn(() => builder);
    builder.range = vi.fn((from: number, to: number) => {
      mode = "range";
      (recorded.rangeCalls[table] ??= []).push([from, to]);
      // Defer resolution to .then so we can compute page from `from/pageSize`
      Object.defineProperty(builder, "__rangeFrom", { value: from, configurable: true });
      Object.defineProperty(builder, "__rangeTo", { value: to, configurable: true });
      return builder;
    });
    builder.single = vi.fn(async () => {
      // `single()` short-circuits the `.then` chain, so we record the
      // write here too. Without this, the common
      // `.insert(v).select().single()` shape would silently skip insert
      // recording — a test relying on `recorded.insert[t]` to assert
      // payload content would falsely see zero writes.
      if (mode === "insert") {
        if (!recorded_once) {
          (recorded.insert[table] ??= []).push({ values: pendingValues ?? {}, eqArgs, neqArgs });
          recorded_once = true;
        }
        return cfg.insert ?? { data: null, error: null };
      }
      return cfg.select ?? { data: null, error: null };
    });
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (mode === "insert") {
        if (!recorded_once) {
          (recorded.insert[table] ??= []).push({ values: pendingValues ?? {}, eqArgs, neqArgs });
          recorded_once = true;
        }
        return Promise.resolve(cfg.insert ?? { data: null, error: null }).then(resolve);
      }
      if (mode === "update") {
        if (!recorded_once) {
          (recorded.update[table] ??= []).push({ values: pendingValues ?? {}, eqArgs, neqArgs });
          recorded_once = true;
        }
        const updateCfg =
          typeof cfg.update === "function"
            ? cfg.update(pendingValues ?? {})
            : cfg.update;
        return Promise.resolve(updateCfg ?? { data: null, error: null }).then(resolve);
      }
      if (mode === "count") {
        if (!recorded_once) {
          (recorded.count[table] ??= []).push({ eqArgs, neqArgs });
          recorded_once = true;
        }
        return Promise.resolve(cfg.count ?? { count: 0, error: null }).then(resolve);
      }
      if (mode === "range") {
        const from = (builder as { __rangeFrom?: number }).__rangeFrom ?? 0;
        const pageSize = cfg.pages?.pageSize ?? 200;
        const pageIdx = Math.floor(from / pageSize);
        const data = cfg.pages?.pages[pageIdx] ?? [];
        return Promise.resolve({ data, error: null }).then(resolve);
      }
      return Promise.resolve(cfg.select ?? { data: null, error: null }).then(resolve);
    };

    return builder;
  }

  return {
    db: { from: (table: string) => build(table) } as unknown as DbPort,
    recorded,
  };
}

/**
 * Build a fake Inngest `step` that runs `step.run` callbacks inline so we
 * can assert call args + side effects. Records every step id for uniqueness
 * checks. `waitForEventReturn` controls what `waitForEvent` resolves to.
 */
export type StepRunCall = { id: string; fn: () => unknown };

export function makeStep(waitForEventReturn: unknown = null) {
  const calls: StepRunCall[] = [];
  const sentEvents: Array<{ id: string; payload: { name: string; data: object } }> = [];
  const step = {
    run: vi.fn(async (id: string, fn: () => unknown) => {
      calls.push({ id, fn });
      return fn();
    }),
    waitForEvent: vi.fn(async () => waitForEventReturn),
    sendEvent: vi.fn(async (id: string, payload: { name: string; data: object }) => {
      sentEvents.push({ id, payload });
      return undefined;
    }),
  };
  return { step, calls, sentEvents };
}

/**
 * Asserts that all `step.run`/`step.sendEvent` ids in a single function
 * invocation are unique. Inngest enforces this at runtime, so any duplicate
 * is a latent production bug — pinning it in tests catches re-entry hazards
 * on error-path branches (e.g. timeout → `mark-batch-failed`) that the happy
 * path doesn't exercise.
 */
export function assertUniqueStepIds(
  calls: StepRunCall[],
  sentEvents: Array<{ id: string }>,
): void {
  const ids = [...calls.map((c) => c.id), ...sentEvents.map((e) => e.id)];
  expect(new Set(ids).size).toBe(ids.length);
}
