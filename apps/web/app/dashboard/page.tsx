export const dynamic = "force-dynamic";

/**
 * Customer dashboard skeleton. Phase 2 wires this to live data via the
 * Supabase RLS path with the customer's session JWT.
 */

export default function CustomerDashboardPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-3xl font-bold">Your campaign</h1>
      <p className="mt-2 text-ink/70">
        We'll show your rewrite, send infra status, and performance here once
        operator approval lands.
      </p>

      <div className="mt-10 grid gap-6 md:grid-cols-3">
        <Card title="Sequence" body="Pending operator approval" />
        <Card title="Send infrastructure" body="Awaiting rewrite approval" />
        <Card title="Performance" body="No data yet — campaign hasn't started" />
      </div>

      <div className="mt-10 rounded-xl border border-ink/10 bg-white p-6">
        <h2 className="text-lg font-semibold">Pause / resume</h2>
        <p className="mt-1 text-sm text-ink/60">
          You can stop sends at any time. Approvals are paused automatically when
          the campaign is paused.
        </p>
        <button className="mt-4 rounded-md border border-ink/20 px-4 py-2 hover:bg-ink/5">
          Pause campaign
        </button>
      </div>
    </main>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-6">
      <h3 className="text-sm uppercase tracking-widest text-ink/60">{title}</h3>
      <p className="mt-2 text-base">{body}</p>
    </div>
  );
}
