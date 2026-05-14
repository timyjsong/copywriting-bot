export const dynamic = "force-dynamic";

/**
 * System health page — placeholder. Phase 2 wires LLM cost burn rate, Inngest
 * run-status counts, error rates from Sentry, and deliverability incidents.
 */

export default function HealthPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">System health</h1>
        <p className="mt-1 text-ink/60">Agent runs, error rates, LLM cost burn, deliverability incidents.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Box title="Inngest" body="See run viewer at /api/inngest (web app)." />
        <Box title="Sentry" body="Configured via SENTRY_DSN; project dashboard external." />
        <Box title="PostHog" body="Funnel viewer external; key in NEXT_PUBLIC_POSTHOG_KEY." />
      </div>
    </div>
  );
}

function Box({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white p-5">
      <h3 className="text-sm uppercase tracking-widest text-ink/60">{title}</h3>
      <p className="mt-2">{body}</p>
    </div>
  );
}
