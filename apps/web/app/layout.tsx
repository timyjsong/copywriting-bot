import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Copywriting Bot — Cold-email rewrites for B2B SaaS founders",
  description:
    "A productized cold-email service for B2B SaaS founders. We rewrite your sequence, stand up the send infrastructure, and monitor 30 days of performance — for $297 one-time.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  openGraph: {
    title: "Copywriting Bot",
    description: "Cold-email rewrites for B2B SaaS founders. $297 one-time.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
