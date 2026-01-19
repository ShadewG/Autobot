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
  NEEDS_HUMAN_REVIEW: 'Needs Review',
};

// Autopilot mode display labels
export const AUTOPILOT_LABELS: Record<string, string> = {
  AUTO: 'Auto',
  SUPERVISED: 'Supervised',
  MANUAL: 'Manual',
};
