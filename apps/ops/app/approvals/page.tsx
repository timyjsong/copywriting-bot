import { serviceClient } from "@copywriting-bot/db/client";
import {
  groupCounts,
  normalizeApprovalPayload,
  slaOverdue,
  timeAgo,
  timeUntil,
} from "@copywriting-bot/shared/approvals";
import { ApprovalSummary } from "./renderers";

export const dynamic = "force-dynamic";

type ApprovalRow = {
  id: string;
  type: string;
  created_at: string;
  customer_id: string | null;
  sla_due_at: string | null;
  payload_json: unknown;
};

export default async function ApprovalsPage() {
  const items = await loadPending();
  const counts = groupCounts(items);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Approval queue</h1>
        <p className="mt-1 text-ink/60">
          Rewrites, send batches, refunds, outbound emails, and support replies awaiting your approval.
        </p>
      </header>

      <div className="flex flex-wrap gap-3 text-xs">
        {Object.entries(counts).map(([type, count]) => (
          <span key={type} className="rounded-md bg-ink/5 px-3 py-1 font-mono">
            {type}: {count}
          </span>
        ))}
        <span className="rounded-md bg-ink px-3 py-1 font-mono text-cream">total: {items.length}</span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink/20 bg-white p-12 text-center text-ink/60">
          Nothing pending. Nice.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const summary = normalizeApprovalPayload(item.type, item.payload_json);
            return (
              <li key={item.id} className="rounded-xl border border-ink/10 bg-white p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-ink px-2 py-1 text-xs uppercase tracking-widest text-cream">
                      {item.type}
                    </span>
                    <span className="text-sm text-ink/60">Created {timeAgo(item.created_at)}</span>
                    {item.sla_due_at && (
                      <span
                        className={`text-xs ${slaOverdue(item.sla_due_at) ? "text-red-600" : "text-ink/50"}`}
                      >
                        SLA {slaOverdue(item.sla_due_at) ? "overdue " : "due in "}
                        {timeUntil(item.sla_due_at)}
                      </span>
                    )}
                  </div>
                  <form action={`/api/approvals/${item.id}`} method="post" className="flex gap-2">
                    <button
                      name="decision"
                      value="reject"
                      className="rounded-md border border-ink/20 px-3 py-1.5 text-sm hover:bg-ink/5"
                    >
                      Reject
                    </button>
                    <button
                      name="decision"
                      value="approve"
                      className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90"
                    >
                      Approve
                    </button>
                  </form>
                </div>
                <ApprovalSummary summary={summary} />
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-ink/50 hover:underline">
                    Raw payload
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded bg-ink/5 p-3 text-xs">
                    {JSON.stringify(item.payload_json, null, 2)}
                  </pre>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

async function loadPending(): Promise<ApprovalRow[]> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("approvals_queue")
      .select("id, type, created_at, customer_id, sla_due_at, payload_json")
      .eq("status", "pending")
      .order("sla_due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) return [];
    return (data ?? []) as ApprovalRow[];
  } catch {
    return [];
  }
}
