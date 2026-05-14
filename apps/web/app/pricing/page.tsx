import Link from "next/link";

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-ink/60 hover:underline">
        ← Back
      </Link>
      <h1 className="mt-6 text-4xl font-bold">One offer. One price. One click.</h1>
      <p className="mt-4 text-ink/70">
        We're a productized service, not an agency. No discovery calls. No MSAs.
        No negotiated pricing.
      </p>

      <div className="mt-10 rounded-2xl border border-ink/10 p-8">
        <p className="text-sm uppercase tracking-widest text-accent">Full rewrite + 30 days</p>
        <p className="mt-2 text-5xl font-bold">$297</p>
        <p className="mt-1 text-sm text-ink/60">one-time, includes everything below</p>
        <ul className="mt-6 space-y-3 text-base">
          <Bullet>Rewrite of every email in your sequence using the SaaS-to-SaaS playbook</Bullet>
          <Bullet>Brand voice scrape from your homepage so the rewrite sounds like you</Bullet>
          <Bullet>Smartlead campaign provisioned on your domain</Bullet>
          <Bullet>10-day warmup schedule + daily caps + deliverability monitoring</Bullet>
          <Bullet>Performance dashboard tracking opens, replies, meetings booked</Bullet>
          <Bullet>21-day milestone check: if reply-rate uplift target missed, free rewrite</Bullet>
          <Bullet>30-day money-back guarantee</Bullet>
        </ul>
        <Link
          href="/roast"
          className="mt-8 inline-block rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90"
        >
          Start with the free roast →
        </Link>
      </div>

      <p className="mt-10 text-sm text-ink/60">
        We only serve B2B SaaS companies selling to other SaaS companies, in
        US/UK/CA/AU. If that's not you, we'll decline gracefully and refund.
      </p>
    </main>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}
