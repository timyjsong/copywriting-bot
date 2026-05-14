import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="flex items-center justify-between">
        <div className="text-lg font-semibold">Copywriting Bot</div>
        <nav className="flex gap-6 text-sm">
          <Link href="/roast" className="hover:underline">
            Roast my cold email
          </Link>
          <Link href="/pricing" className="hover:underline">
            Pricing
          </Link>
        </nav>
      </header>

      <section className="mt-20 max-w-3xl">
        <p className="text-sm uppercase tracking-widest text-accent">
          For B2B SaaS founders selling to other SaaS companies
        </p>
        <h1 className="mt-3 text-5xl font-bold leading-tight md:text-6xl">
          Rewriting cold emails that finally get replies.
        </h1>
        <p className="measure mt-6 text-lg text-ink/80">
          You paste your sequence. We rewrite it using the SaaS-to-SaaS playbook,
          stand up dedicated send infrastructure on your domain, and monitor 30
          days of performance. <strong>$297 one-time. No discovery calls.</strong>
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/roast"
            className="rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90"
          >
            Get a free roast of your sequence →
          </Link>
          <Link
            href="/pricing"
            className="rounded-md border border-ink/20 px-5 py-3 hover:bg-ink/5"
          >
            See pricing
          </Link>
        </div>
        <p className="mt-3 text-sm text-ink/60">
          21-day reply-rate lift in writing or your money back.
        </p>
      </section>

      <section className="mt-24 grid gap-8 md:grid-cols-3">
        <Feature
          title="Optimisation, not generation"
          body="We never start from a blank brief. We rewrite what you've already tested — so the lift is measurable against your real baseline."
        />
        <Feature
          title="Niche-deep on SaaS-to-SaaS"
          body="One ICP. One playbook. We refuse DTC, agencies, local services. That focus is what makes the rewrites work."
        />
        <Feature
          title="Infra included"
          body="Smartlead campaign, 10-day warmup, daily caps, deliverability monitoring — all set up by the bot. No spreadsheet handoff."
        />
      </section>

      <section className="mt-24 rounded-2xl bg-ink p-10 text-cream">
        <h2 className="text-3xl font-semibold">How it works</h2>
        <ol className="mt-6 space-y-4 text-base">
          <Step n={1}>Paste your sequence into the free Roast tool.</Step>
          <Step n={2}>Get a scored critique on 6 dimensions in under a minute.</Step>
          <Step n={3}>
            Upgrade to a full rewrite for $297. We rebuild every email, stand up
            send infra on your domain, and run it for 30 days.
          </Step>
          <Step n={4}>
            On day 21 we check uplift vs. your baseline. If we missed, we rewrite
            free or refund.
          </Step>
        </ol>
      </section>

      <footer className="mt-20 flex flex-wrap items-center justify-between gap-3 border-t border-ink/10 pt-8 text-sm text-ink/60">
        <div>© Copywriting Bot</div>
        <nav className="flex gap-6">
          <Link href="/terms" className="hover:underline">Terms</Link>
          <Link href="/privacy" className="hover:underline">Privacy</Link>
          <Link href="/refund" className="hover:underline">Refund policy</Link>
        </nav>
      </footer>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-ink/70">{body}</p>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cream/10 text-sm font-mono">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
