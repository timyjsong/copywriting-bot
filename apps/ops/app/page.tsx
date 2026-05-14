import Link from "next/link";
import { serviceClient } from "@copywriting-bot/db/client";

export const dynamic = "force-dynamic";

export default async function OperatorHome() {
  const stats = await loadStats();
  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-3xl font-bold">Operator overview</h1>
        <p className="mt-1 text-ink/60">Approval queues, customer status, and system burn.</p>
      </section>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Pending approvals" value={stats.pendingApprovals} href="/approvals" />
        <Stat label="Active customers" value={stats.activeCustomers} href="/customers" />
        <Stat label="Onboarding" value={stats.onboardingCustomers} href="/customers" />
        <Stat label="Roasts today" value={stats.roastsToday} />
      </div>

      <section className="rounded-xl border border-ink/10 bg-white p-6">
        <h2 className="text-lg font-semibold">Quick links</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li><Link href="/approvals" className="text-accent hover:underline">Approval queue →</Link></li>
          <li><Link href="/customers" className="text-accent hover:underline">Customer list →</Link></li>
          <li><Link href="/health" className="text-accent hover:underline">System health →</Link></li>
        </ul>
      </section>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number | string; href?: string }) {
  const inner = (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <div className="text-sm uppercase tracking-widest text-ink/60">{label}</div>
      <div className="mt-2 text-3xl font-bold">{value}</div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

async function loadStats(): Promise<{
  pendingApprovals: number;
  activeCustomers: number;
  onboardingCustomers: number;
  roastsToday: number;
}> {
  // In dev without Supabase credentials, return zeros instead of crashing.
  try {
    const db = serviceClient();
    const [{ count: pending }, { count: active }, { count: onboarding }, { count: roasts }] = await Promise.all([
      db.from("approvals_queue").select("id", { count: "exact", head: true }).eq("status", "pending"),
      db.from("customers").select("id", { count: "exact", head: true }).eq("status", "active"),
      db.from("customers").select("id", { count: "exact", head: true }).eq("status", "onboarding"),
      db.from("roasts").select("id", { count: "exact", head: true }).gte("created_at", todayIso()),
    ]);
    return {
      pendingApprovals: pending ?? 0,
      activeCustomers: active ?? 0,
      onboardingCustomers: onboarding ?? 0,
      roastsToday: roasts ?? 0,
    };
  } catch {
    return { pendingApprovals: 0, activeCustomers: 0, onboardingCustomers: 0, roastsToday: 0 };
  }
}

function todayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
