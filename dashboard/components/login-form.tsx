"use client";

import { useEffect } from "react";
import { useAuth } from "./auth-provider";

export function LoginForm() {
  const { redirectToPortal } = useAuth();

  useEffect(() => {
    redirectToPortal();
  }, [redirectToPortal]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-xs space-y-4 text-center">
        <h1 className="text-xs font-bold tracking-widest uppercase text-muted-foreground">
          AUTOBOT
        </h1>
        <p className="text-xs text-muted-foreground uppercase tracking-wider">
          Redirecting to portal...
        </p>
        <button
          type="button"
          onClick={redirectToPortal}
          className="w-full h-9 text-xs font-medium uppercase tracking-wider border border-border text-foreground hover:bg-card transition-colors"
        >
          Continue to Portal
        </button>
      </div>
    </div>
  );
}
