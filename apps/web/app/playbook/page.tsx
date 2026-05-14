import Link from "next/link";
import type { Metadata } from "next";
import { PLAYBOOK } from "./content";

export const metadata: Metadata = {
  title: "The B2B SaaS cold-email playbook — Copywriting Bot",
  description:
    "Honest, specific cold-email advice for B2B SaaS founders selling to other SaaS companies. No fluff, no clickbait.",
};

export default function PlaybookIndexPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <Link href="/" className="text-sm text-ink/60 hover:underline">
        ← Back to home
      </Link>
      <h1 className="mt-6 text-4xl font-bold">The B2B SaaS cold-email playbook</h1>
      <p className="measure mt-3 text-lg text-ink/80">
        Specific, opinionated answers to the cold-email questions B2B SaaS founders actually ask. We
        publish the same playbook we use on customer rewrites — so you can sanity-check us before
        paying.
      </p>

      <ul className="mt-12 space-y-6">
        {PLAYBOOK.map((entry) => (
          <li key={entry.slug} className="rounded-xl border border-ink/10 bg-white p-6">
            <h2 className="text-xl font-semibold">
              <Link href={`/playbook/${entry.slug}`} className="hover:underline">
                {entry.title}
              </Link>
            </h2>
            <p className="mt-2 text-ink/70">{entry.intent}</p>
          </li>
        ))}
      </ul>

      <section className="mt-16 rounded-2xl bg-ink p-8 text-cream">
        <h2 className="text-2xl font-semibold">Want us to score your sequence?</h2>
        <p className="mt-3 text-cream/80">
          Free. Roughly 30 seconds. We score on 6 dimensions and rewrite the worst email so you can
          see the bar.
        </p>
        <Link
          href="/roast"
          className="mt-6 inline-block rounded-md bg-cream px-5 py-3 text-ink hover:bg-cream/90"
        >
          Roast my cold email →
        </Link>
      </section>
    </main>
  );
}
