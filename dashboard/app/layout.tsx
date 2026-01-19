import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";

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
        <TooltipProvider>
          <div className="min-h-screen bg-background">
            <nav className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <div className="container flex h-14 items-center">
                <div className="mr-4 flex">
                  <a href="/dashboard/requests" className="mr-6 flex items-center space-x-2">
                    <span className="font-bold">FOIA Dashboard</span>
                  </a>
                  <nav className="flex items-center space-x-6 text-sm font-medium">
                    <a
                      href="/dashboard/requests"
                      className="transition-colors hover:text-foreground/80 text-foreground"
                    >
                      Requests
                    </a>
                    <a
                      href="/dashboard/agencies"
                      className="transition-colors hover:text-foreground/80 text-muted-foreground"
                    >
                      Agencies
                    </a>
                  </nav>
                </div>
              </div>
            </nav>
            <main className="container py-6">{children}</main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
