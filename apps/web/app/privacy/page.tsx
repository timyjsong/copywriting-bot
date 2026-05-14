import Link from "next/link";

export const metadata = { title: "Privacy Policy — Copywriting Bot" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-ink/60 hover:underline">
        ← Back
      </Link>
      <h1 className="mt-6 text-4xl font-bold">Privacy Policy</h1>
      <p className="mt-2 text-sm text-ink/60">Last updated: 2026-05-14</p>

      <section className="mt-8 space-y-4 text-ink/90">
        <p>
          We collect the minimum information needed to deliver the Service: your email, company domain, ICP
          description, brand voice URL, and sending domain credentials. We do not store the personal data of your
          prospects beyond the send-log retention required to attribute results.
        </p>
        <p>
          We use Stripe for payments, Supabase for storage, Smartlead for send infrastructure, Anthropic for LLM
          inference, Sentry for error tracking, and PostHog for product analytics. Each of those vendors has its own
          privacy policy.
        </p>
        <p>
          You can request deletion of your account and associated data at any time by emailing us. We delete within 30
          days unless required by law to retain.
        </p>
      </section>
    </main>
  );
}
