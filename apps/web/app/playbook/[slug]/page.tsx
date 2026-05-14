import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PLAYBOOK, getEntry } from "../content";

export async function generateStaticParams() {
  return PLAYBOOK.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = getEntry(slug);
  if (!entry) return { title: "Playbook entry not found" };
  return {
    title: `${entry.title} — Copywriting Bot`,
    description: entry.intent,
    openGraph: {
      title: entry.title,
      description: entry.intent,
      type: "article",
    },
  };
}

export default async function PlaybookEntryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = getEntry(slug);
  if (!entry) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/playbook" className="text-sm text-ink/60 hover:underline">
        ← Back to playbook
      </Link>
      <h1 className="mt-6 text-4xl font-bold leading-tight">{entry.title}</h1>

      <article className="mt-10 space-y-8 text-lg text-ink/85">
        <section>
          <h2 className="text-sm uppercase tracking-widest text-accent">Who this is for</h2>
          <p className="mt-2">{entry.intent}</p>
        </section>

        <section>
          <h2 className="text-sm uppercase tracking-widest text-accent">The pain</h2>
          <p className="mt-2">{entry.painPoint}</p>
        </section>

        <section>
          <h2 className="text-sm uppercase tracking-widest text-accent">What we believe</h2>
          <p className="mt-2 font-medium text-ink">{entry.principle}</p>
        </section>

        <section>
          <h2 className="text-sm uppercase tracking-widest text-accent">Evidence from a real cohort</h2>
          <p className="mt-2">{entry.counterExample}</p>
        </section>
      </article>

      <section className="mt-16 rounded-2xl border-2 border-accent bg-cream p-8">
        <p className="text-sm uppercase tracking-widest text-accent">Next step</p>
        <h3 className="mt-2 text-2xl font-semibold">{entry.cta}</h3>
        <Link
          href="/roast"
          className="mt-6 inline-block rounded-md bg-ink px-5 py-3 text-cream hover:bg-ink/90"
        >
          Roast my cold email →
        </Link>
      </section>

      <nav className="mt-16 flex flex-wrap gap-3 border-t border-ink/10 pt-8 text-sm">
        <span className="text-ink/60">Related:</span>
        {PLAYBOOK.filter((e) => e.slug !== entry.slug)
          .slice(0, 3)
          .map((e) => (
            <Link key={e.slug} href={`/playbook/${e.slug}`} className="text-ink/80 hover:underline">
              {e.title}
            </Link>
          ))}
      </nav>
    </main>
  );
}
