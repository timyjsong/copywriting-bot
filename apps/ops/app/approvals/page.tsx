import { serviceClient } from "@copywriting-bot/db/client";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const items = await loadPending();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Approval queue</h1>
        <p className="mt-1 text-ink/60">
          Rewrites, send batches, refunds, outbound emails, and support replies awaiting your approval.
        </p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink/20 bg-white p-12 text-center text-ink/60">
          Nothing pending. Nice.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl border border-ink/10 bg-white p-5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="rounded-md bg-ink px-2 py-1 text-xs uppercase tracking-widest text-cream">
                    {item.type}
                  </span>
                  <span className="ml-3 text-sm text-ink/60">
                    Created {new Date(item.created_at).toLocaleString()}
                  </span>
                </div>
                <form action={`/api/approvals/${item.id}`} method="post" className="flex gap-2">
                  <button name="decision" value="reject" className="rounded-md border border-ink/20 px-3 py-1.5 text-sm hover:bg-ink/5">
                    Reject
                  </button>
                  <button name="decision" value="approve" className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90">
                    Approve
                  </button>
                </form>
              </div>
              <pre className="mt-4 max-h-72 overflow-auto rounded bg-ink/5 p-3 text-xs">
                {JSON.stringify(item.payload_json, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function loadPending(): Promise<
  Array<{ id: string; type: string; created_at: string; payload_json: unknown }>
> {
  try {
    const db = serviceClient();
    const { data, error } = await db
      .from("approvals_queue")
      .select("id, type, created_at, payload_json")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) return [];
    return (data ?? []) as Array<{
      id: string;
      type: string;
      created_at: string;
      payload_json: unknown;
    }>;
  } catch {
    return [];
  }
}
