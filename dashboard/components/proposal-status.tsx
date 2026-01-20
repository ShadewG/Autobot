"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { Clock, CheckCircle, XCircle, Loader2, Send, AlertCircle } from "lucide-react";

export type ProposalState = "PENDING" | "QUEUED" | "SENDING" | "SENT" | "FAILED" | "BLOCKED";

interface ProposalStatusProps {
  state: ProposalState;
  queuedAt?: string | null;
  scheduledFor?: string | null;
  sentAt?: string | null;
  blockedReason?: string | null;
  failedReason?: string | null;
}

/**
 * Shows the current state of an approved proposal with detailed status.
 * Critical for trust - users need to know exactly what's happening.
 */
export function ProposalStatus({
  state,
  queuedAt,
  scheduledFor,
  sentAt,
  blockedReason,
  failedReason,
}: ProposalStatusProps) {
  switch (state) {
    case "QUEUED":
      return (
        <div className="flex items-center gap-2 text-sm bg-blue-50 dark:bg-blue-950/30 rounded px-3 py-1.5">
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Queued
          </Badge>
          <span className="text-xs">
            {scheduledFor ? (
              <>Scheduled for <span className="font-medium">{formatDateTime(scheduledFor)}</span></>
            ) : (
              <>Will send in 2-10 hours (human-like delay)</>
            )}
          </span>
        </div>
      );

    case "SENDING":
      return (
        <div className="flex items-center gap-2 text-sm bg-yellow-50 dark:bg-yellow-950/30 rounded px-3 py-1.5">
          <Badge variant="secondary" className="gap-1 bg-yellow-100 text-yellow-800">
            <Loader2 className="h-3 w-3 animate-spin" />
            Sending
          </Badge>
          <span className="text-xs">Message is being sent now...</span>
        </div>
      );

    case "SENT":
      return (
        <div className="flex items-center gap-2 text-sm bg-green-50 dark:bg-green-950/30 rounded px-3 py-1.5">
          <Badge variant="default" className="gap-1 bg-green-600">
            <CheckCircle className="h-3 w-3" />
            Sent
          </Badge>
          {sentAt && (
            <span className="text-xs">
              Delivered {formatDateTime(sentAt)}
            </span>
          )}
        </div>
      );

    case "FAILED":
      return (
        <div className="flex items-center gap-2 text-sm bg-red-50 dark:bg-red-950/30 rounded px-3 py-1.5">
          <Badge variant="destructive" className="gap-1">
            <AlertCircle className="h-3 w-3" />
            Failed
          </Badge>
          <span className="text-xs text-red-700 dark:text-red-300">
            {failedReason || "Delivery failed - will retry"}
          </span>
        </div>
      );

    case "BLOCKED":
      return (
        <div className="flex items-center gap-2 text-sm bg-red-50 dark:bg-red-950/30 rounded px-3 py-1.5">
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" />
            Blocked
          </Badge>
          <span className="text-xs text-red-700 dark:text-red-300">
            {blockedReason || "Blocked by safety validator"}
          </span>
        </div>
      );

    case "PENDING":
    default:
      return null;
  }
}

/**
 * Inline badge for showing proposal state in button area
 */
export function ProposalStatusBadge({ state }: { state: ProposalState }) {
  switch (state) {
    case "QUEUED":
      return (
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <Clock className="h-2.5 w-2.5" />
          Queued
        </Badge>
      );
    case "SENDING":
      return (
        <Badge variant="secondary" className="gap-1 text-[10px] bg-yellow-100 text-yellow-800">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Sending
        </Badge>
      );
    case "SENT":
      return (
        <Badge variant="default" className="gap-1 text-[10px] bg-green-600">
          <CheckCircle className="h-2.5 w-2.5" />
          Sent
        </Badge>
      );
    case "FAILED":
      return (
        <Badge variant="destructive" className="gap-1 text-[10px]">
          <AlertCircle className="h-2.5 w-2.5" />
          Failed
        </Badge>
      );
    case "BLOCKED":
      return (
        <Badge variant="destructive" className="gap-1 text-[10px]">
          <XCircle className="h-2.5 w-2.5" />
          Blocked
        </Badge>
      );
    default:
      return null;
  }
}
