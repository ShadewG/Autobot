"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fetcher, type ProposalsListResponse, type AgentRun } from "@/lib/api";

export function NavLinks() {
  const pathname = usePathname();
  const isGated = pathname.startsWith("/gated");
  const isInbox = pathname.startsWith("/inbox");
  const isRequests = pathname.startsWith("/requests");
  const isPortalTasks = pathname.startsWith("/portal-tasks");
  const isAgencies = pathname.startsWith("/agencies");
  const isRuns = pathname.startsWith("/runs");
  const isShadow = pathname.startsWith("/shadow");

  // Fetch pending proposal count for badge
  const { data: proposalsData } = useSWR<ProposalsListResponse>(
    "/proposals?limit=100",
    fetcher,
    { refreshInterval: 30000 }
  );
  const pendingCount = proposalsData?.count || 0;

  // Fetch gated runs count for badge
  const { data: gatedData } = useSWR<{ success: boolean; runs: AgentRun[] }>(
    "/runs?status=gated&limit=100",
    fetcher,
    { refreshInterval: 30000 }
  );
  const gatedCount = gatedData?.runs?.length || 0;

  return (
    <nav className="flex items-center space-x-6 text-sm font-medium">
      <Link
        href="/gated"
        className={cn(
          "transition-colors hover:text-foreground/80 flex items-center gap-1",
          isGated ? "text-foreground font-semibold" : "text-muted-foreground"
        )}
      >
        Gated
        {gatedCount > 0 && (
          <Badge variant="destructive" className="h-5 px-1.5 text-xs">
            {gatedCount}
          </Badge>
        )}
      </Link>
      <Link
        href="/inbox"
        className={cn(
          "transition-colors hover:text-foreground/80 flex items-center gap-1",
          isInbox ? "text-foreground font-semibold" : "text-muted-foreground"
        )}
      >
        Inbox
        {pendingCount > 0 && (
          <Badge variant="destructive" className="h-5 px-1.5 text-xs">
            {pendingCount}
          </Badge>
        )}
      </Link>
      <Link
        href="/requests"
        className={cn(
          "transition-colors hover:text-foreground/80",
          isRequests ? "text-foreground" : "text-muted-foreground"
        )}
      >
        Requests
      </Link>
      <Link
        href="/portal-tasks"
        className={cn(
          "transition-colors hover:text-foreground/80",
          isPortalTasks ? "text-foreground" : "text-muted-foreground"
        )}
      >
        Portal Tasks
      </Link>
      <Link
        href="/agencies"
        className={cn(
          "transition-colors hover:text-foreground/80",
          isAgencies ? "text-foreground" : "text-muted-foreground"
        )}
      >
        Agencies
      </Link>
      <Link
        href="/runs"
        className={cn(
          "transition-colors hover:text-foreground/80",
          isRuns ? "text-foreground" : "text-muted-foreground"
        )}
      >
        Runs
      </Link>
      <Link
        href="/shadow"
        className={cn(
          "transition-colors hover:text-foreground/80",
          isShadow ? "text-foreground" : "text-muted-foreground"
        )}
      >
        Shadow
      </Link>
    </nav>
  );
}
