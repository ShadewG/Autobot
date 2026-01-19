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
    }
  ) => {
    return fetchAPI(`/requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  // Approve a pending action
  approve: (id: string, actionId?: string) => {
    return fetchAPI(`/requests/${id}/actions/approve`, {
      method: 'POST',
      body: JSON.stringify({ action_id: actionId }),
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
};

// SWR fetcher
export const fetcher = <T>(url: string): Promise<T> => fetchAPI(url);
