"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";

/**
 * Wraps admin-only pages. Redirects non-admin users to /gated.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && (!user || !user.is_admin)) {
      router.replace("/gated");
    }
  }, [user, loading, router]);

  if (loading || !user?.is_admin) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-xs text-muted-foreground uppercase tracking-widest">
          Loading...
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
