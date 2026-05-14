import { vi } from "vitest";

/**
 * Consolidated Supabase test fake. Each table is configured up-front with
 * what it should return for the query shapes the production code uses. All
 * write side-effects are captured on the returned `recorded` object so tests
 * can assert exactly what was written.
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
  update?: { data?: unknown; error?: unknown };
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
  serviceClient: () => { from: (table: string) => unknown };
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
        (recorded.upsert[table] ??= []).push({ values: pendingValues ?? {}, eqArgs, neqArgs });
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
      if (mode === "insert") return cfg.insert ?? { data: null, error: null };
      return cfg.select ?? { data: null, error: null };
    });
    builder.then = (resolve: (v: unknown) => unknown) => {
      if (mode === "insert") {
        (recorded.insert[table] ??= []).push({ values: pendingValues ?? {}, eqArgs, neqArgs });
        return Promise.resolve(cfg.insert ?? { data: null, error: null }).then(resolve);
      }
      if (mode === "update") {
        (recorded.update[table] ??= []).push({ values: pendingValues ?? {}, eqArgs, neqArgs });
        return Promise.resolve(cfg.update ?? { data: null, error: null }).then(resolve);
      }
      if (mode === "count") {
        (recorded.count[table] ??= []).push({ eqArgs, neqArgs });
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
    serviceClient: () => ({ from: (table: string) => build(table) }),
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
