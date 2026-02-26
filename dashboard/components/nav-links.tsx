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
  const { appendUser } = useUserFilter();
  const { user, logout } = useAuth();

  const { data: liveData } = useSWR<{
    success: boolean;
    summary: { pending_approvals_total: number; human_review_total: number };
  }>(appendUser("/api/monitor/live-overview?limit=1"), {
    refreshInterval: 30000,
  });
  const queueCount =
    (liveData?.summary?.pending_approvals_total || 0) +
    (liveData?.summary?.human_review_total || 0);

  const links = [
    { href: "/gated", label: "QUEUE", count: queueCount },
    { href: "/requests", label: "CASES" },
    { href: "/runs", label: "RUNS" },
    { href: "/agencies", label: "AGENCIES" },
    { href: "/eval", label: "EVALS" },
    { href: "/settings", label: "SETTINGS" },
  ];

  return (
    <div className="flex items-center justify-between flex-1">
      <nav className="flex items-center gap-6 text-xs tracking-wider">
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
      {user && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">{user.name}</span>
          <button
            onClick={logout}
            className="text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
}
