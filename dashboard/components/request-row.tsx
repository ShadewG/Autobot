"use client";

import { useRouter } from "next/navigation";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StageChip } from "./stage-chip";
import { GateChip } from "./gate-chip";
import { AtRiskBadge } from "./at-risk-badge";
import type { RequestListItem } from "@/lib/types";
import type { TableVariant } from "./request-table";
import { formatRelativeTime, truncate, cn } from "@/lib/utils";
import { Eye, ArrowRight, DollarSign, Calendar, AlertTriangle } from "lucide-react";

interface RequestRowProps {
  request: RequestListItem;
  variant: TableVariant;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
}

// Build the "next action" microline based on request state
function getNextActionLine(request: RequestListItem, variant: TableVariant): string | null {
  if (variant === "paused") {
    // For paused: show what decision is needed
    if (request.pause_reason === "FEE_QUOTE" && request.cost_amount) {
      return `Decision required: Fee $${request.cost_amount.toLocaleString()}`;
    }
    if (request.pause_reason === "DENIAL") {
      return "Decision required: Denial received";
    }
    if (request.pause_reason === "SCOPE") {
      return "Decision required: Scope clarification";
    }
    if (request.pause_reason === "ID_REQUIRED") {
      return "Decision required: ID verification";
    }
    if (request.pause_reason === "SENSITIVE") {
      return "Decision required: Sensitive content";
    }
    if (request.pause_reason === "CLOSE_ACTION") {
      return "Decision required: Confirm completion";
    }
    return "Decision required";
  }

  // For waiting/scheduled: show next due date info
  if (request.due_info?.due_type && request.next_due_at) {
    const dueDate = new Date(request.next_due_at);
    const formatted = dueDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    switch (request.due_info.due_type) {
      case "FOLLOW_UP":
        return `Next follow-up: ${formatted}`;
      case "STATUTORY":
        return `Statutory due: ${formatted}`;
      case "AGENCY_PROMISED":
        return `Agency promised: ${formatted}`;
      case "SNOOZED":
        return `Snoozed until: ${formatted}`;
    }
  }

  if (request.next_due_at) {
    const dueDate = new Date(request.next_due_at);
    const formatted = dueDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return `Due: ${formatted}`;
  }

  return null;
}

// Format the due date with type context
function formatDueWithType(request: RequestListItem): { text: string; isOverdue: boolean } {
  if (!request.next_due_at) {
    return { text: "", isOverdue: false };
  }

  const dueDate = new Date(request.next_due_at);
  const now = new Date();
  const isOverdue = dueDate < now;

  const formatted = dueDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  // Add type prefix if available
  let typePrefix = "";
  if (request.due_info?.due_type) {
    switch (request.due_info.due_type) {
      case "FOLLOW_UP":
        typePrefix = "F/U ";
        break;
      case "STATUTORY":
        typePrefix = "Stat ";
        break;
      case "AGENCY_PROMISED":
        typePrefix = "Prom ";
        break;
    }
  }

  return {
    text: `${typePrefix}${formatted}`,
    isOverdue,
  };
}

export function RequestRow({
  request,
  variant,
  onApprove,
  onAdjust,
  onSnooze,
}: RequestRowProps) {
  const router = useRouter();
  const isPaused = variant === "paused";

  const handleClick = () => {
    router.push(`/requests/detail?id=${request.id}`);
  };

  const nextActionLine = getNextActionLine(request, variant);
  const dueInfo = formatDueWithType(request);

  // Agency display: hide state if empty or missing
  const agencyDisplay = request.state && request.state !== "—"
    ? `${request.agency_name}, ${request.state}`
    : request.agency_name;

  // Inbound display: show "No response" if null and in waiting state
  const inboundDisplay = request.last_inbound_at
    ? formatRelativeTime(request.last_inbound_at)
    : variant === "waiting"
    ? "No response"
    : "";

  return (
    <TableRow
      className={cn(
        "cursor-pointer transition-colors",
        isPaused && "bg-amber-50/50 hover:bg-amber-100/50"
      )}
      onClick={handleClick}
    >
      {/* ID with at-risk badge */}
      <TableCell className="font-mono text-sm">
        <div className="flex items-center gap-1.5">
          {request.at_risk && <AtRiskBadge />}
          <span>{request.id}</span>
        </div>
      </TableCell>

      {/* Subject / Agency + Next Action microline */}
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium truncate max-w-[250px]">
            {truncate(request.subject, 45)}
          </span>
          <span className="text-xs text-muted-foreground">
            {agencyDisplay}
          </span>
          {nextActionLine && (
            <span className={cn(
              "text-xs",
              isPaused ? "text-amber-700 font-medium" : "text-muted-foreground"
            )}>
              {nextActionLine}
            </span>
          )}
        </div>
      </TableCell>

      {/* Gate chip - only for paused */}
      {isPaused && (
        <TableCell>
          {request.pause_reason && (
            <GateChip
              reason={request.pause_reason}
              costAmount={request.cost_amount}
            />
          )}
        </TableCell>
      )}

      {/* Stage */}
      <TableCell>
        <StageChip
          status={request.status}
          autopilotMode={request.autopilot_mode}
          pauseReason={request.pause_reason}
          nextDueAt={request.next_due_at}
        />
      </TableCell>

      {/* Inbound */}
      <TableCell className={cn(
        "text-sm",
        !request.last_inbound_at && "text-muted-foreground"
      )}>
        {inboundDisplay}
      </TableCell>

      {/* Due with type + overdue indicator */}
      <TableCell>
        {dueInfo.text ? (
          <div className="flex items-center gap-1.5">
            {dueInfo.isOverdue && (
              <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
            )}
            <span className={cn(
              "text-sm",
              dueInfo.isOverdue && "text-red-600 font-medium"
            )}>
              {dueInfo.text}
            </span>
          </div>
        ) : null}
      </TableCell>

      {/* Cost - only show if there's a cost */}
      <TableCell>
        {request.cost_amount ? (
          <div className="flex items-center gap-1">
            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">
              {request.cost_amount.toLocaleString()}
            </span>
          </div>
        ) : null}
      </TableCell>

      {/* Action - context-aware */}
      <TableCell onClick={(e) => e.stopPropagation()} className="text-right">
        {isPaused ? (
          <Button
            size="sm"
            variant="default"
            className="h-7 px-3"
            onClick={() => onApprove?.(request.id)}
          >
            Review
            <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-3"
            onClick={handleClick}
          >
            <Eye className="h-3.5 w-3.5 mr-1" />
            Open
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
