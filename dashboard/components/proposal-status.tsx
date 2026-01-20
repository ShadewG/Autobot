"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { Clock, CheckCircle, XCircle, Loader2 } from "lucide-react";

export type ProposalState = "PENDING" | "QUEUED" | "SENT" | "BLOCKED";

interface ProposalStatusProps {
  state: ProposalState;
  queuedAt?: string | null;
  scheduledFor?: string | null;
  sentAt?: string | null;
  blockedReason?: string | null;
}

/**
 * Shows the current state of an approved proposal:
 * - PENDING: Waiting for approval
 * - QUEUED: Approved, scheduled to send with human-like delay
 * - SENT: Message has been sent
 * - BLOCKED: Validator blocked execution
 */
export function ProposalStatus({
  state,
  queuedAt,
  scheduledFor,
  sentAt,
  blockedReason,
}: ProposalStatusProps) {
  switch (state) {
    case "QUEUED":
      return (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Queued
          </Badge>
          {scheduledFor && (
            <span className="text-xs text-muted-foreground">
              Will send ~{formatDateTime(scheduledFor)}
            </span>
          )}
          {!scheduledFor && queuedAt && (
            <span className="text-xs text-muted-foreground">
              Queued {formatDateTime(queuedAt)} — will send in 2-10 hours
            </span>
          )}
        </div>
      );

    case "SENT":
      return (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="default" className="gap-1 bg-green-600">
            <CheckCircle className="h-3 w-3" />
            Sent
          </Badge>
          {sentAt && (
            <span className="text-xs text-muted-foreground">
              {formatDateTime(sentAt)}
            </span>
          )}
        </div>
      );

    case "BLOCKED":
      return (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" />
            Blocked
          </Badge>
          {blockedReason && (
            <span className="text-xs text-muted-foreground">
              {blockedReason}
            </span>
          )}
        </div>
      );

    case "PENDING":
    default:
      return null; // Don't show anything for pending state
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
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Queued
        </Badge>
      );
    case "SENT":
      return (
        <Badge variant="default" className="gap-1 text-[10px] bg-green-600">
          <CheckCircle className="h-2.5 w-2.5" />
          Sent
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
