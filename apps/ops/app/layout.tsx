import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Copywriting Bot — Operator dashboard",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-ink/10 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <div className="text-lg font-semibold">Copywriting Bot · Ops</div>
            <nav className="flex gap-6 text-sm">
              <Link href="/" className="hover:underline">Overview</Link>
              <Link href="/approvals" className="hover:underline">Approvals</Link>
              <Link href="/customers" className="hover:underline">Customers</Link>
              <Link href="/health" className="hover:underline">System health</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
