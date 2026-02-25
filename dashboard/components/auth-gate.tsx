"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAuth } from "./auth-provider";
import { LoginForm } from "./login-form";
import { NavLinks } from "./nav-links";

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-xs text-muted-foreground uppercase tracking-widest">
          Loading...
        </p>
      </div>
    );
  }

  if (!user) {
    return <LoginForm />;
  }

  return (
    <div className="min-h-screen bg-background">
      <nav className="sticky top-0 z-40 border-b bg-background">
        <div className="flex h-10 items-center px-4">
          <Link
            href="/gated"
            className="mr-8 text-xs font-bold tracking-widest uppercase text-muted-foreground hover:text-foreground"
          >
            AUTOBOT
          </Link>
          <NavLinks />
        </div>
      </nav>
      <main className="px-4 py-4">{children}</main>
    </div>
  );
}
