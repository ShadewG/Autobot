"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fetcher, type ProposalsListResponse, type AgentRun } from "@/lib/api";

export function NavLinks() {
  const pathname = usePathname();

  const { data: gatedData } = useSWR<{ success: boolean; runs: AgentRun[] }>(
    "/runs?status=gated&limit=100",
    fetcher,
    { refreshInterval: 30000 }
  );
  const gatedCount = gatedData?.runs?.length || 0;

  const links = [
    { href: "/gated", label: "QUEUE", count: gatedCount },
    { href: "/requests", label: "CASES" },
    { href: "/runs", label: "RUNS" },
    { href: "/agencies", label: "AGENCIES" },
  ];

  return (
    <nav className="flex items-center gap-6 text-xs tracking-wider">
      {links.map(({ href, label, count }) => {
        const isActive = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-1.5 uppercase transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
            {count != null && count > 0 && (
              <Badge variant="destructive" className="h-4 px-1 text-[10px] leading-none">
                {count}
              </Badge>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
