import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "@/components/providers";
import { NavLinks } from "@/components/nav-links";
import { EnvironmentBanner } from "@/components/environment-banner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FOIA Request Dashboard",
  description: "Monitor and manage FOIA requests",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <EnvironmentBanner />
          <div className="min-h-screen bg-background">
            <nav className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <div className="container flex h-14 items-center">
                <div className="mr-4 flex">
                  <Link href="/requests" className="mr-6 flex items-center space-x-2">
                    <span className="font-bold">FOIA Dashboard</span>
                  </Link>
                  <NavLinks />
                </div>
              </div>
            </nav>
            <main className="container py-6">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
