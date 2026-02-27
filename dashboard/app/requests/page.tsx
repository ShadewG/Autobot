"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { InboxSections } from "@/components/inbox-sections";
import { NotionImport } from "@/components/notion-import";
import { useUserFilter } from "@/components/user-filter";
import { requestsAPI, fetcher } from "@/lib/api";
import type { RequestsListResponse, RequestListItem, PauseReason } from "@/lib/types";
import { Search, Loader2 } from "lucide-react";

// Pause reason priority for sorting (lower = higher priority)
const PAUSE_PRIORITY: Record<PauseReason, number> = {
  FEE_QUOTE: 1,    // Fast to clear
  DENIAL: 2,
  SCOPE: 3,
  ID_REQUIRED: 4,
  SENSITIVE: 5,
  CLOSE_ACTION: 6,
};

// Sort by: overdue first, then at-risk, then by due date, then by pause priority
function sortPaused(requests: RequestListItem[]): RequestListItem[] {
  const now = new Date();

  return [...requests].sort((a, b) => {
    // 1. Overdue items first
    const aOverdue = a.next_due_at ? new Date(a.next_due_at) < now : false;
    const bOverdue = b.next_due_at ? new Date(b.next_due_at) < now : false;
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

    // 2. At-risk items next
    if (a.at_risk !== b.at_risk) return a.at_risk ? -1 : 1;

    // 3. Sort by pause reason priority (Fee Quote first)
    const aPriority = a.pause_reason ? PAUSE_PRIORITY[a.pause_reason] || 99 : 99;
    const bPriority = b.pause_reason ? PAUSE_PRIORITY[b.pause_reason] || 99 : 99;
    if (aPriority !== bPriority) return aPriority - bPriority;

    // 4. Sort by due date (earliest first)
    if (a.next_due_at && b.next_due_at) {
      return new Date(a.next_due_at).getTime() - new Date(b.next_due_at).getTime();
    }
    if (a.next_due_at) return -1;
    if (b.next_due_at) return 1;

    return 0;
  });
}

// Sort by: overdue first, then at-risk, then by due date
function sortWaiting(requests: RequestListItem[]): RequestListItem[] {
  const now = new Date();

  return [...requests].sort((a, b) => {
    // 1. Overdue items first
    const aOverdue = a.next_due_at ? new Date(a.next_due_at) < now : false;
    const bOverdue = b.next_due_at ? new Date(b.next_due_at) < now : false;
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

    // 2. At-risk items next
    if (a.at_risk !== b.at_risk) return a.at_risk ? -1 : 1;

    // 3. Sort by due date (earliest first)
    if (a.next_due_at && b.next_due_at) {
      return new Date(a.next_due_at).getTime() - new Date(b.next_due_at).getTime();
    }
    if (a.next_due_at) return -1;
    if (b.next_due_at) return 1;

    // 4. Fall back to last activity
    return new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime();
  });
}

export default function RequestsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const { appendUser } = useUserFilter();

  const { data, error, isLoading, mutate } = useSWR<RequestsListResponse>(
    appendUser("/requests"),
    fetcher,
    { refreshInterval: 30000 }
  );

  const handleApprove = async (id: string) => {
    // Navigate to detail page for review
    window.location.href = `/requests/detail?id=${id}`;
  };

  const handleAdjust = (id: string) => {
    window.location.href = `/requests/detail?id=${id}&adjust=true`;
  };

  const handleSnooze = async (id: string) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    try {
      await requestsAPI.update(id, {
        next_due_at: tomorrow.toISOString(),
      });
      mutate();
    } catch (err) {
      console.error("Failed to snooze:", err);
    }
  };

  const handleRepair = async (id: string) => {
    try {
      await requestsAPI.resetToLastInbound(id);
      mutate();
    } catch (err) {
      console.error("Failed to repair case state:", err);
      alert("Failed to repair and requeue case");
    }
  };

  // Split requests into 3 categories
  const { paused, waiting, scheduled } = useMemo(() => {
    if (!data?.requests) {
      return { paused: [], waiting: [], scheduled: [] };
    }

    let filtered = data.requests;

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.subject.toLowerCase().includes(query) ||
          r.agency_name.toLowerCase().includes(query) ||
          r.id.includes(query)
      );
    }

    const now = new Date();

    // Paused: requires_human = true
    const pausedItems = filtered.filter((r) => r.requires_human);

    // Not paused items
    const notPaused = filtered.filter((r) => !r.requires_human);

    // Scheduled: has next_due_at in the future and not paused
    const scheduledItems = notPaused.filter((r) => {
      if (!r.next_due_at) return false;
      const dueDate = new Date(r.next_due_at);
      // Consider it "scheduled" if the due date is in the future
      // and it's a follow-up type (not statutory deadline)
      return dueDate > now && r.due_info?.due_type === "FOLLOW_UP";
    });

    // Waiting: everything else not paused and not in scheduled
    const scheduledIds = new Set(scheduledItems.map((r) => r.id));
    const waitingItems = notPaused.filter((r) => !scheduledIds.has(r.id));

    return {
      paused: sortPaused(pausedItems),
      waiting: sortWaiting(waitingItems),
      scheduled: sortWaiting(scheduledItems),
    };
  }, [data, searchQuery]);

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load requests</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Requests</h1>
        <div className="flex items-center gap-3">
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search requests..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8"
            />
          </div>
          <NotionImport onImported={() => mutate()} />
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <InboxSections
          paused={paused}
          waiting={waiting}
          scheduled={scheduled}
          completed={data?.completed || []}
          onApprove={handleApprove}
          onAdjust={handleAdjust}
          onSnooze={handleSnooze}
          onRepair={handleRepair}
        />
      )}
    </div>
  );
}
