import Link from "next/link";

export const metadata = { title: "Refund Policy — Copywriting Bot" };

export default function RefundPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/" className="text-sm text-ink/60 hover:underline">
        ← Back
      </Link>
      <h1 className="mt-6 text-4xl font-bold">Refund Policy</h1>
      <p className="mt-2 text-sm text-ink/60">Last updated: 2026-05-14</p>

      <section className="mt-8 space-y-4 text-ink/90">
        <p>
          30-day money-back guarantee: if you're not satisfied within 30 days of purchase, email us and we'll
          refund in full, no questions asked.
        </p>
        <p>
          21-day reply-rate uplift: at the 21-day mark we measure your reply rate against your stated baseline.
          If we missed the target uplift (default: +10% over baseline), we automatically offer either a free
          rewrite or a refund — your choice.
        </p>
        <p>
          Refunds are issued via the original payment method through Stripe and typically clear within 5–10 business
          days. Email refunds@copywritingbot.com to initiate.
        </p>
      </section>
    </main>
  );
}
