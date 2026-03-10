"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useUserFilter } from "./user-filter";
import { useAuth } from "./auth-provider";

export function NavLinks() {
  const pathname = usePathname();
  const { appendUser, isAdmin, viewAll, setViewAll } = useUserFilter();
  const { user, logout } = useAuth();

  const { data: liveData } = useSWR<{
    success: boolean;
    summary: { pending_approvals_total: number; human_review_total: number };
  }>(appendUser("/api/monitor/live-overview?limit=1"), {
    refreshInterval: 10000,
  });
  const queueCount =
    (liveData?.summary?.pending_approvals_total || 0) +
    (liveData?.summary?.human_review_total || 0);

  const links = [
    { href: "/gated", label: "QUEUE", count: queueCount },
    { href: "/requests", label: "CASES" },
    { href: "/agencies", label: "AGENCIES" },
    { href: "/lessons", label: "LESSONS" },
    { href: "/analytics", label: "ANALYTICS" },
    { href: "/settings", label: "SETTINGS" },
    { href: "/feedback", label: "FEEDBACK" },
    // Admin-only tabs: internal tooling and diagnostics
    ...(isAdmin
      ? [
          { href: "/runs", label: "RUNS" },
          { href: "/eval", label: "EVALS" },
          { href: "/examples", label: "EXAMPLES" },
          { href: "/reconciliation", label: "RECON" },
          { href: "/errors", label: "ERRORS" },
          { href: "/simulate", label: "SIM" },
          { href: "/admin", label: "ADMIN" },
        ]
      : []),
  ];

  return (
    <div className="flex min-w-0 w-full flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <nav className="flex min-w-0 items-center gap-4 overflow-x-auto whitespace-nowrap pr-1 text-xs tracking-wider [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:gap-6">
        {links.map(({ href, label, count }) => {
          const isActive = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-1.5 uppercase transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
              {count != null && count > 0 && (
                <Badge
                  variant="destructive"
                  className="h-4 px-1 text-[10px] leading-none"
                >
                  {count}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-wrap items-center gap-3 text-xs md:justify-end">
        {process.env.NEXT_PUBLIC_FOIA_RESEARCHER_URL && (
          <a
            href={process.env.NEXT_PUBLIC_FOIA_RESEARCHER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="uppercase tracking-wider text-blue-400 hover:text-blue-300 transition-colors"
          >
            RESEARCHER
          </a>
        )}
        {isAdmin && (
          <button
            onClick={() => setViewAll(!viewAll)}
            className={cn(
              "uppercase tracking-wider transition-colors",
              viewAll ? "text-amber-400" : "text-muted-foreground hover:text-foreground"
            )}
            title={viewAll ? "Viewing all users" : "Viewing your cases only"}
          >
            {viewAll ? "ALL USERS" : "MY CASES"}
          </button>
        )}
        <Link
          href="/onboarding"
          className={cn(
            "uppercase tracking-wider transition-colors",
            pathname === "/onboarding" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Guide
        </Link>
        <Link
          href="/changelog"
          className={cn(
            "uppercase tracking-wider transition-colors",
            pathname === "/changelog" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Changelog
        </Link>
        {user && (
          <>
            <span className="max-w-[160px] truncate text-muted-foreground">{user.email}</span>
            <button
              onClick={logout}
              className="text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
            >
              Logout
            </button>
          </>
        )}
      </div>
    </div>
  );
}
