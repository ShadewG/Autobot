"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function NavLinks() {
  const pathname = usePathname();
  const isQueue = pathname.startsWith("/queue");
  const isRequests = pathname.startsWith("/requests");
  const isAgencies = pathname.startsWith("/agencies");
  const isRuns = pathname.startsWith("/runs");

  return (
    <nav className="flex items-center space-x-6 text-sm font-medium">
      <Link
        href="/queue"
        className={cn(
          "transition-colors hover:text-foreground/80",
          isQueue ? "text-foreground font-semibold" : "text-muted-foreground"
        )}
      >
        Queue
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
    </nav>
  );
}
