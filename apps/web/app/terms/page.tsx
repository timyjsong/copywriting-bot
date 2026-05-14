import Link from "next/link";

export const metadata = { title: "Terms of Service — Copywriting Bot" };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-ink/60 hover:underline">
        ← Back
      </Link>
      <h1 className="mt-6 text-4xl font-bold">Terms of Service</h1>
      <p className="mt-2 text-sm text-ink/60">Last updated: 2026-05-14</p>

      <section className="prose mt-8 space-y-4 text-ink/90">
        <p>
          By purchasing or using Copywriting Bot ("the Service"), you agree to these terms.
        </p>

        <h2 className="mt-8 text-xl font-semibold">1. Eligibility</h2>
        <p>
          The Service is offered only to entities incorporated in the United States, United Kingdom, Canada, or Australia,
          operating B2B SaaS products sold to other SaaS companies. If you do not meet this profile we reserve the right
          to refund and decline service.
        </p>

        <h2 className="mt-8 text-xl font-semibold">2. Customer representations</h2>
        <p>You represent and warrant that:</p>
        <ul className="list-disc pl-6">
          <li>You own or have rights to the sending domain provided.</li>
          <li>You have lawful, opted-in, or otherwise compliant lists for any outreach we send on your behalf.</li>
          <li>All product claims, metrics, and positioning you provide are accurate and verifiable.</li>
          <li>You will review every customer-facing email before mass sending.</li>
        </ul>

        <h2 className="mt-8 text-xl font-semibold">3. Service</h2>
        <p>
          We rewrite your existing cold-email sequence, provision a Smartlead campaign on your domain, monitor
          performance for 30 days, and deliver a final report. All AI-generated copy is routed to operator approval
          before being sent to your prospects.
        </p>

        <h2 className="mt-8 text-xl font-semibold">4. Compliance</h2>
        <p>
          You are solely responsible for compliance with CAN-SPAM, CASL, GDPR, and any other applicable
          anti-spam / privacy regulations in jurisdictions you send to. We refuse to send to lists that appear
          purchased, scraped without basis, or otherwise non-compliant.
        </p>

        <h2 className="mt-8 text-xl font-semibold">5. Refunds</h2>
        <p>
          A 30-day money-back guarantee applies. If our 21-day reply-rate uplift target is missed for your campaign,
          we will automatically offer a free rewrite or refund per our{" "}
          <Link href="/refund" className="underline">refund policy</Link>.
        </p>

        <h2 className="mt-8 text-xl font-semibold">6. Limitations</h2>
        <p>
          The Service is provided "as is." We do not guarantee a specific reply rate or revenue outcome. Our liability
          is limited to the fees paid in the prior 90 days.
        </p>

        <h2 className="mt-8 text-xl font-semibold">7. Changes</h2>
        <p>
          We may update these terms. Continued use after publication constitutes acceptance. Material changes are
          emailed to active customers.
        </p>
      </section>
    </main>
  );
}
