"use client";

import useSWR from "swr";
import { useCallback, useMemo } from "react";
import type { RequestWorkspaceResponse, NextAction } from "@/lib/types";
import { toWorkspaceVM, type WorkspaceVM } from "@/lib/selectors/requestViewModel";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api";

async function fetchWorkspace(url: string): Promise<RequestWorkspaceResponse> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `API error: ${res.status}`);
  }

  return res.json();
}

interface UseRequestWorkspaceOptions {
  refreshInterval?: number;
}

interface UseRequestWorkspaceReturn {
  workspace: WorkspaceVM | null;
  isLoading: boolean;
  error: Error | null;
  // Actions with optimistic updates
  approve: (actionId?: string, costCap?: number) => Promise<{ scheduled_send_at?: string }>;
  revise: (instruction: string, actionId?: string) => Promise<NextAction | null>;
  dismiss: (actionId?: string) => Promise<void>;
  snooze: (snoozeUntil: string) => Promise<void>;
  refresh: () => void;
}

/**
 * Unified workspace hook with single SWR key.
 * All mutations update the same cache.
 */
export function useRequestWorkspace(
  requestId: string | null,
  options: UseRequestWorkspaceOptions = {}
): UseRequestWorkspaceReturn {
  const { refreshInterval = 0 } = options;

  const swrKey = requestId ? `/requests/${requestId}/workspace` : null;

  const { data, error, isLoading, mutate } = useSWR<RequestWorkspaceResponse>(
    swrKey,
    fetchWorkspace,
    {
      refreshInterval,
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    }
  );

  // Memoize the transformed workspace
  const workspace = useMemo(() => {
    if (!data) return null;
    return toWorkspaceVM(data);
  }, [data]);

  // Approve with optimistic update
  const approve = useCallback(
    async (actionId?: string, costCap?: number) => {
      if (!requestId) throw new Error("No request ID");

      const res = await fetch(`${API_BASE}/requests/${requestId}/actions/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_id: actionId, cost_cap: costCap }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(error.error || `API error: ${res.status}`);
      }

      const result = await res.json();

      // Optimistic update: clear next_action_proposal
      mutate(
        (current) => {
          if (!current) return current;
          return {
            ...current,
            next_action_proposal: null,
          };
        },
        { revalidate: true }
      );

      return result;
    },
    [requestId, mutate]
  );

  // Revise with optimistic update
  const revise = useCallback(
    async (instruction: string, actionId?: string) => {
      if (!requestId) throw new Error("No request ID");

      const res = await fetch(`${API_BASE}/requests/${requestId}/actions/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, action_id: actionId }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(error.error || `API error: ${res.status}`);
      }

      const result = await res.json();

      // Optimistic update: replace next_action_proposal
      if (result.next_action_proposal) {
        mutate(
          (current) => {
            if (!current) return current;
            return {
              ...current,
              next_action_proposal: result.next_action_proposal,
            };
          },
          { revalidate: false }
        );
      }

      return result.next_action_proposal || null;
    },
    [requestId, mutate]
  );

  // Dismiss with optimistic update
  const dismiss = useCallback(
    async (actionId?: string) => {
      if (!requestId) throw new Error("No request ID");

      const res = await fetch(`${API_BASE}/requests/${requestId}/actions/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_id: actionId }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(error.error || `API error: ${res.status}`);
      }

      // Optimistic update: clear next_action_proposal
      mutate(
        (current) => {
          if (!current) return current;
          return {
            ...current,
            next_action_proposal: null,
          };
        },
        { revalidate: true }
      );
    },
    [requestId, mutate]
  );

  // Snooze
  const snooze = useCallback(
    async (snoozeUntil: string) => {
      if (!requestId) throw new Error("No request ID");

      const res = await fetch(`${API_BASE}/requests/${requestId}/snooze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snooze_until: snoozeUntil }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(error.error || `API error: ${res.status}`);
      }

      // Revalidate to get updated due_info
      mutate();
    },
    [requestId, mutate]
  );

  const refresh = useCallback(() => {
    mutate();
  }, [mutate]);

  return {
    workspace,
    isLoading,
    error: error || null,
    approve,
    revise,
    dismiss,
    snooze,
    refresh,
  };
}
