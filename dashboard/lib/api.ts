import type {
  RequestsListResponse,
  RequestWorkspaceResponse,
  NextAction,
} from './types';

// API is at root /api, not under /dashboard
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

// Generic fetch wrapper with error handling
async function fetchAPI<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${res.status}`);
  }

  return res.json();
}

// Requests API
export const requestsAPI = {
  // List all requests with optional filters
  list: (params?: {
    requires_human?: boolean;
    status?: string;
    q?: string;
  }): Promise<RequestsListResponse> => {
    const searchParams = new URLSearchParams();
    if (params?.requires_human !== undefined) {
      searchParams.set('requires_human', String(params.requires_human));
    }
    if (params?.status) {
      searchParams.set('status', params.status);
    }
    if (params?.q) {
      searchParams.set('q', params.q);
    }
    const query = searchParams.toString();
    return fetchAPI(`/requests${query ? `?${query}` : ''}`);
  },

  // Get workspace data for a single request
  getWorkspace: (id: string): Promise<RequestWorkspaceResponse> => {
    return fetchAPI(`/requests/${id}/workspace`);
  },

  // Update request fields
  update: (
    id: string,
    data: {
      autopilot_mode?: string;
      requires_human?: boolean;
      pause_reason?: string | null;
      next_due_at?: string;
    }
  ) => {
    return fetchAPI(`/requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  // Approve a pending action
  approve: (
    id: string,
    actionId?: string,
    costCap?: number
  ): Promise<{ success: boolean; scheduled_send_at?: string }> => {
    return fetchAPI(`/requests/${id}/actions/approve`, {
      method: 'POST',
      body: JSON.stringify({
        action_id: actionId,
        cost_cap: costCap,
      }),
    });
  },

  // Revise a pending action
  revise: (
    id: string,
    instruction: string,
    actionId?: string
  ): Promise<{ success: boolean; next_action_proposal: NextAction }> => {
    return fetchAPI(`/requests/${id}/actions/revise`, {
      method: 'POST',
      body: JSON.stringify({ instruction, action_id: actionId }),
    });
  },

  // Dismiss a pending action
  dismiss: (id: string, actionId?: string) => {
    return fetchAPI(`/requests/${id}/actions/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ action_id: actionId }),
    });
  },

  // Withdraw/close a request
  withdraw: (
    id: string,
    reason?: string
  ): Promise<{ success: boolean; message: string }> => {
    return fetchAPI(`/requests/${id}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  // Invoke agent on a request
  invokeAgent: (
    id: string,
    triggerType?: string
  ): Promise<{ success: boolean; run_id?: string; message?: string }> => {
    return fetchAPI(`/requests/${id}/invoke-agent`, {
      method: 'POST',
      body: JSON.stringify({ trigger_type: triggerType || 'manual' }),
    });
  },

  // Get agent runs for a request
  getAgentRuns: (id: string): Promise<{ runs: AgentRun[] }> => {
    return fetchAPI(`/requests/${id}/agent-runs`);
  },

  // Get agent run details with diff
  getAgentRunDiff: (id: string, runId: string): Promise<AgentRunDiff> => {
    return fetchAPI(`/requests/${id}/agent-runs/${runId}/diff`);
  },

  // Replay an agent run
  replayAgentRun: (
    id: string,
    runId: string
  ): Promise<{ success: boolean; new_run_id?: string }> => {
    return fetchAPI(`/requests/${id}/agent-runs/${runId}/replay`, {
      method: 'POST',
    });
  },

  // Update autopilot mode
  setAutopilotMode: (
    id: string,
    mode: 'AUTO' | 'SUPERVISED' | 'MANUAL'
  ): Promise<{ success: boolean }> => {
    return fetchAPI(`/requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ autopilot_mode: mode }),
    });
  },
};

// Agent run types
export interface AgentRun {
  id: string;
  case_id: string;
  trigger_type: string;
  status: 'running' | 'completed' | 'failed' | 'gated';
  started_at: string;
  completed_at?: string;
  error_message?: string;
  node_trace?: string[];
  final_action?: string;
  gated_reason?: string;
}

export interface AgentRunDiff {
  run: AgentRun;
  state_before: Record<string, unknown>;
  state_after: Record<string, unknown>;
  logs: string[];
  snapshots: Array<{
    node: string;
    timestamp: string;
    state: Record<string, unknown>;
  }>;
}

// SWR fetcher
export const fetcher = <T>(url: string): Promise<T> => fetchAPI(url);
