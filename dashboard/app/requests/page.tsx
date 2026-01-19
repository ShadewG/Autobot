"use client";

import { useState } from "react";
import useSWR from "swr";
import { Input } from "@/components/ui/input";
import { InboxSections } from "@/components/inbox-sections";
import { requestsAPI, fetcher } from "@/lib/api";
import type { RequestsListResponse } from "@/lib/types";
import { Search, Loader2 } from "lucide-react";

export default function RequestsPage() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data, error, isLoading, mutate } = useSWR<RequestsListResponse>(
    "/requests",
    fetcher,
    { refreshInterval: 30000 } // Refresh every 30 seconds
  );

  const handleApprove = async (id: string) => {
    try {
      await requestsAPI.approve(id);
      mutate(); // Refresh the list
    } catch (err) {
      console.error("Failed to approve:", err);
    }
  };

  const handleAdjust = (id: string) => {
    // Navigate to detail page with adjust dialog open
    window.location.href = `/requests/detail?id=${id}&adjust=true`;
  };

  const handleSnooze = async (id: string) => {
    // For V1, snooze for 24 hours
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

  // Filter requests locally (V1 approach)
  const filterRequests = (requests: typeof data) => {
    if (!requests?.requests) return { paused: [], ongoing: [] };

    let filtered = requests.requests;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.subject.toLowerCase().includes(query) ||
          r.agency_name.toLowerCase().includes(query) ||
          r.id.includes(query)
      );
    }

    const paused = filtered.filter((r) => r.requires_human);
    const ongoing = filtered.filter((r) => !r.requires_human);

    // Sort paused by due date, then by pause reason priority
    const pausePriority: Record<string, number> = {
      FEE_QUOTE: 1,
      DENIAL: 2,
      SCOPE: 3,
      ID_REQUIRED: 4,
      SENSITIVE: 5,
      CLOSE_ACTION: 6,
    };

    paused.sort((a, b) => {
      // First sort by at_risk
      if (a.at_risk !== b.at_risk) return a.at_risk ? -1 : 1;

      // Then by due date
      if (a.next_due_at && b.next_due_at) {
        return new Date(a.next_due_at).getTime() - new Date(b.next_due_at).getTime();
      }
      if (a.next_due_at) return -1;
      if (b.next_due_at) return 1;

      // Then by pause reason priority
      const aPriority = a.pause_reason ? pausePriority[a.pause_reason] || 99 : 99;
      const bPriority = b.pause_reason ? pausePriority[b.pause_reason] || 99 : 99;
      return aPriority - bPriority;
    });

    // Sort ongoing by last activity
    ongoing.sort(
      (a, b) =>
        new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime()
    );

    return { paused, ongoing };
  };

  const { paused, ongoing } = filterRequests(data);

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
        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search requests..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8"
            />
          </div>
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
          ongoing={ongoing}
          onApprove={handleApprove}
          onAdjust={handleAdjust}
          onSnooze={handleSnooze}
        />
      )}
    </div>
  );
}
