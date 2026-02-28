"use client";

import { useState, useMemo, useCallback } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { InboxSections } from "@/components/inbox-sections";
import { NotionImport } from "@/components/notion-import";
import { useUserFilter } from "@/components/user-filter";
import { requestsAPI, fetcher } from "@/lib/api";
import type { RequestsListResponse, RequestListItem, PauseReason } from "@/lib/types";
import { Search, Loader2 } from "lucide-react";

// Pause reason priority for sorting (lower = higher priority)
const PAUSE_PRIORITY: Record<string, number> = {
  FEE_QUOTE: 1,
  DENIAL: 2,
  SCOPE: 3,
  ID_REQUIRED: 4,
  SENSITIVE: 5,
  CLOSE_ACTION: 6,
  portal_failed: 7,
  email_send_failed: 8,
  agent_run_failed: 9,
  escalated: 10,
  stuck_portal_task: 11,
  portal_stuck: 12,
  portal_timed_out: 13,
  execution_blocked: 14,
  proposal_pending: 15,
  UNSPECIFIED: 16,
};

// Unified impact sort: overdue > out-of-sync > at-risk > pause priority / due date > last activity
function sortByImpact(requests: RequestListItem[]): RequestListItem[] {
  const now = new Date();

  return [...requests].sort((a, b) => {
    // 1. Overdue items first
    const aOverdue = a.next_due_at ? new Date(a.next_due_at) < now : false;
    const bOverdue = b.next_due_at ? new Date(b.next_due_at) < now : false;
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

    // 2. Out of sync (control mismatches) next
    const aMismatch = (a.control_mismatches?.length ?? 0) > 0;
    const bMismatch = (b.control_mismatches?.length ?? 0) > 0;
    if (aMismatch !== bMismatch) return aMismatch ? -1 : 1;

    // 3. At-risk items next
    if (a.at_risk !== b.at_risk) return a.at_risk ? -1 : 1;

    // 4. Sort by pause reason priority
    const aPriority = a.pause_reason ? PAUSE_PRIORITY[a.pause_reason] ?? 99 : 99;
    const bPriority = b.pause_reason ? PAUSE_PRIORITY[b.pause_reason] ?? 99 : 99;
    if (aPriority !== bPriority) return aPriority - bPriority;

    // 5. Sort by due date (earliest first)
    if (a.next_due_at && b.next_due_at) {
      return new Date(a.next_due_at).getTime() - new Date(b.next_due_at).getTime();
    }
    if (a.next_due_at) return -1;
    if (b.next_due_at) return 1;

    // 6. Fall back to last activity (most recent first)
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
    window.location.href = `/requests/detail?id=${id}`;
  };

  const handleAdjust = (id: string) => {
    window.location.href = `/requests/detail?id=${id}&adjust=true`;
  };

  const handleSnooze = async (id: string) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    try {
      await requestsAPI.update(id, { next_due_at: tomorrow.toISOString() });
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

  const handleFollowUp = useCallback(async (id: string) => {
    try {
      await requestsAPI.invokeAgent(id, "follow_up");
      mutate();
    } catch (err) {
      console.error("Failed to send follow-up:", err);
    }
  }, [mutate]);

  const handleTakeOver = useCallback(async (id: string) => {
    try {
      await requestsAPI.update(id, { autopilot_mode: "MANUAL" });
      mutate();
    } catch (err) {
      console.error("Failed to take over:", err);
    }
  }, [mutate]);

  const handleGuideAI = useCallback((id: string) => {
    window.location.href = `/requests/detail?id=${id}&adjust=true`;
  }, []);

  const handleCancelRun = useCallback(async (id: string) => {
    try {
      // Navigate to detail page where they can cancel
      window.location.href = `/requests/detail?id=${id}`;
    } catch (err) {
      console.error("Failed to cancel run:", err);
    }
  }, []);

  // Bulk action handler
  const handleBulkAction = useCallback(async (ids: string[], action: string) => {
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        switch (action) {
          case "follow_up":
            return requestsAPI.invokeAgent(id, "follow_up");
          case "take_over":
            return requestsAPI.update(id, { autopilot_mode: "MANUAL" });
          case "requeue":
            return requestsAPI.resetToLastInbound(id);
          case "set_manual":
            return requestsAPI.update(id, { autopilot_mode: "MANUAL" });
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    mutate();
    return { succeeded, failed };
  }, [mutate]);

  // Split requests into 3 buckets using review_state as primary discriminator
  const { needsDecision, botWorking, waitingOnAgency } = useMemo(() => {
    if (!data?.requests) {
      return { needsDecision: [], botWorking: [], waitingOnAgency: [] };
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

    const needsDecisionItems: RequestListItem[] = [];
    const botWorkingItems: RequestListItem[] = [];
    const waitingItems: RequestListItem[] = [];

    for (const r of filtered) {
      if (r.review_state) {
        // Use review_state as primary discriminator (canonical)
        switch (r.review_state) {
          case "DECISION_REQUIRED":
            needsDecisionItems.push(r);
            break;
          case "PROCESSING":
          case "DECISION_APPLYING":
            botWorkingItems.push(r);
            break;
          case "WAITING_AGENCY":
          case "IDLE":
          default:
            waitingItems.push(r);
            break;
        }
      } else {
        // Fallback: use requires_human + active_run_status heuristic
        if (r.requires_human) {
          needsDecisionItems.push(r);
        } else if (
          r.active_run_status &&
          ["created", "queued", "processing", "waiting", "running"].includes(
            r.active_run_status.toLowerCase()
          )
        ) {
          botWorkingItems.push(r);
        } else {
          waitingItems.push(r);
        }
      }
    }

    return {
      needsDecision: sortByImpact(needsDecisionItems),
      botWorking: sortByImpact(botWorkingItems),
      waitingOnAgency: sortByImpact(waitingItems),
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
          needsDecision={needsDecision}
          botWorking={botWorking}
          waitingOnAgency={waitingOnAgency}
          completed={data?.completed || []}
          onApprove={handleApprove}
          onAdjust={handleAdjust}
          onSnooze={handleSnooze}
          onRepair={handleRepair}
          onFollowUp={handleFollowUp}
          onTakeOver={handleTakeOver}
          onGuideAI={handleGuideAI}
          onCancelRun={handleCancelRun}
          onBulkAction={handleBulkAction}
        />
      )}
    </div>
  );
}
