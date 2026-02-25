import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Format date for display
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

// Format date with time
export function formatDateTime(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Format relative time (e.g., "2 hours ago")
export function formatRelativeTime(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(date);
}

// Format countdown to due date
export function formatDueCountdown(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';

  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs < 0) {
    const overdueDays = Math.abs(diffDays);
    return `${overdueDays}d overdue`;
  }
  if (diffHours < 24) return `${diffHours}h`;
  return `${diffDays}d`;
}

// Format currency
export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

// Truncate text
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// Pause reason display labels
export const PAUSE_REASON_LABELS: Record<string, string> = {
  FEE_QUOTE: 'Fee Quote',
  SCOPE: 'Scope Issue',
  DENIAL: 'Denial',
  ID_REQUIRED: 'ID Required',
  SENSITIVE: 'Sensitive',
  CLOSE_ACTION: 'Close Action',
};

// Status display labels
export const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  READY_TO_SEND: 'Ready to Send',
  AWAITING_RESPONSE: 'Awaiting Response',
  RECEIVED_RESPONSE: 'Response Received',
  CLOSED: 'Closed',
  NEEDS_HUMAN_REVIEW: 'Paused',
};

// Autopilot mode display labels
export const AUTOPILOT_LABELS: Record<string, string> = {
  AUTO: 'Auto',
  SUPERVISED: 'Supervised',
  MANUAL: 'Manual',
};

// Normalize reasoning items to display strings.
// Backend stores reasoning as either string[] or {step, detail}[] objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatReasoningItem(item: any): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const step = item.step || '';
    const detail = item.detail || '';
    if (step && detail) return `${step}: ${detail}`;
    return step || detail || JSON.stringify(item);
  }
  return String(item);
}

// Normalize an entire reasoning array, capping at maxItems (from the end).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatReasoning(reasoning: any[] | null | undefined, maxItems?: number): string[] {
  if (!Array.isArray(reasoning) || reasoning.length === 0) return [];
  const formatted = reasoning.map(formatReasoningItem);
  if (maxItems && formatted.length > maxItems) {
    return formatted.slice(-maxItems);
  }
  return formatted;
}

// Action type display config — shared across queue page, detail page, panels
export const ACTION_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  SEND_INITIAL_REQUEST: { label: "Initial Request", color: "bg-blue-500/10 text-blue-400" },
  SEND_FOLLOWUP: { label: "Follow-up", color: "bg-purple-500/10 text-purple-400" },
  SEND_REBUTTAL: { label: "Rebuttal", color: "bg-red-500/10 text-red-400" },
  SEND_CLARIFICATION: { label: "Clarification", color: "bg-orange-500/10 text-orange-400" },
  SEND_APPEAL: { label: "Appeal", color: "bg-orange-500/10 text-orange-400" },
  SEND_FEE_WAIVER_REQUEST: { label: "Fee Waiver", color: "bg-amber-500/10 text-amber-400" },
  SEND_STATUS_UPDATE: { label: "Status Update", color: "bg-sky-500/10 text-sky-400" },
  RESPOND_PARTIAL_APPROVAL: { label: "Partial Approval", color: "bg-teal-500/10 text-teal-400" },
  ACCEPT_FEE: { label: "Accept Fee", color: "bg-green-500/10 text-green-400" },
  NEGOTIATE_FEE: { label: "Negotiate Fee", color: "bg-amber-500/10 text-amber-400" },
  DECLINE_FEE: { label: "Decline Fee", color: "bg-red-500/10 text-red-400" },
  SUBMIT_PORTAL: { label: "Portal Submission", color: "bg-cyan-500/10 text-cyan-400" },
  SEND_PDF_EMAIL: { label: "PDF Email", color: "bg-indigo-500/10 text-indigo-400" },
  ESCALATE: { label: "Escalate", color: "bg-yellow-500/10 text-yellow-400" },
  CLOSE_CASE: { label: "Close Case", color: "bg-gray-500/10 text-gray-400" },
  WITHDRAW: { label: "Withdraw", color: "bg-red-500/10 text-red-400" },
  RESEARCH_AGENCY: { label: "Research Agency", color: "bg-violet-500/10 text-violet-400" },
  REFORMULATE_REQUEST: { label: "Reformulate", color: "bg-fuchsia-500/10 text-fuchsia-400" },
  NONE: { label: "No Action", color: "bg-gray-500/10 text-gray-400" },
};
