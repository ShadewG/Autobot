import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "@/components/providers";
import { NavLinks } from "@/components/nav-links";

const mono = JetBrains_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AUTOBOT",
  description: "FOIA case operations",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={mono.className}>
        <Providers>
          <div className="min-h-screen bg-background">
            <nav className="sticky top-0 z-40 border-b bg-background">
              <div className="flex h-10 items-center px-4">
                <Link href="/gated" className="mr-8 text-xs font-bold tracking-widest uppercase text-muted-foreground hover:text-foreground">
                  AUTOBOT
                </Link>
                <NavLinks />
              </div>
            </nav>
            <main className="px-4 py-4">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
