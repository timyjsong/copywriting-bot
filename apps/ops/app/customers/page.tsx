import { serviceClient } from "@copywriting-bot/db/client";

export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const rows = await loadCustomers();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">Customers</h1>
        <p className="mt-1 text-ink/60">Status, tier, and approval-gate setting per customer.</p>
      </header>

      <div className="overflow-hidden rounded-xl border border-ink/10 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-ink/5 text-left text-xs uppercase tracking-widest text-ink/60">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Domain</th>
              <th className="px-4 py-3">Tier</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Gates</th>
              <th className="px-4 py-3">Signed up</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-ink/50">No customers yet.</td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-ink/5">
                <td className="px-4 py-3 font-mono text-xs">{c.email}</td>
                <td className="px-4 py-3">{c.company_domain ?? "—"}</td>
                <td className="px-4 py-3">{c.tier}</td>
                <td className="px-4 py-3">{c.status}</td>
                <td className="px-4 py-3">{c.operator_approval_gates_on ? "on" : "off"}</td>
                <td className="px-4 py-3 text-ink/60">{new Date(c.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function loadCustomers() {
  try {
    const db = serviceClient();
    const { data } = await db
      .from("customers")
      .select("id, email, company_domain, tier, status, operator_approval_gates_on, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    return data ?? [];
  } catch {
    return [];
  }
}
