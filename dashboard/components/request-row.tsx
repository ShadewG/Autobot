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
import { Eye, ArrowRight, DollarSign, AlertTriangle, HelpCircle } from "lucide-react";

interface RequestRowProps {
  request: RequestListItem;
  variant: TableVariant;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
}

// Format the due date with overdue severity
function formatDueWithSeverity(request: RequestListItem): {
  text: string;
  overdueDays: number | null;
  isOverdue: boolean;
  typeChip: string | null;
} {
  if (!request.next_due_at) {
    return { text: "", overdueDays: null, isOverdue: false, typeChip: null };
  }

  const dueDate = new Date(request.next_due_at);
  const now = new Date();
  const diffMs = now.getTime() - dueDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const isOverdue = diffDays > 0;

  const formatted = dueDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  // Type chip based on due_type
  let typeChip: string | null = null;
  if (request.due_info?.due_type) {
    switch (request.due_info.due_type) {
      case "FOLLOW_UP":
        typeChip = "F/U";
        break;
      case "STATUTORY":
        typeChip = "Stat";
        break;
      case "AGENCY_PROMISED":
        typeChip = "Prom";
        break;
      case "SNOOZED":
        typeChip = "Snz";
        break;
    }
  }

  return {
    text: formatted,
    overdueDays: isOverdue ? diffDays : null,
    isOverdue,
    typeChip,
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

  const dueInfo = formatDueWithSeverity(request);

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

  // For paused rows, build a short inbound summary line
  // This would ideally come from the API, but for now we build from available data
  const getInboundSummary = (): string | null => {
    if (!isPaused) return null;

    const parts: string[] = [];

    // Fee info
    if (request.pause_reason === "FEE_QUOTE" && request.cost_amount) {
      parts.push(`$${request.cost_amount} fee`);
    }

    // Add cost status context
    if (request.cost_status === "QUOTED") {
      parts.push("quote received");
    } else if (request.cost_status === "INVOICED") {
      parts.push("invoiced");
    }

    // For denial
    if (request.pause_reason === "DENIAL") {
      parts.push("request denied");
    }

    // For scope
    if (request.pause_reason === "SCOPE") {
      parts.push("clarification needed");
    }

    return parts.length > 0 ? parts.join(", ") : null;
  };

  const inboundSummary = getInboundSummary();

  return (
    <TableRow
      className={cn(
        "cursor-pointer transition-colors",
        isPaused && "bg-amber-500/10/50 hover:bg-amber-500/15/50"
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

      {/* Subject / Agency + Inbound summary for paused */}
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium truncate max-w-[280px]">
            {truncate(request.subject, 50)}
          </span>
          <span className="text-xs text-muted-foreground">
            {agencyDisplay}
          </span>
          {/* Last inbound summary for paused rows */}
          {isPaused && inboundSummary && (
            <span className="text-xs text-amber-300 font-medium">
              {inboundSummary}
            </span>
          )}
        </div>
      </TableCell>

      {/* Gate - mandatory for paused, shows "Unknown" if missing */}
      {isPaused && (
        <TableCell>
          {request.pause_reason ? (
            <GateChip
              reason={request.pause_reason}
              costAmount={request.cost_amount}
            />
          ) : (
            <Badge variant="outline" className="gap-1 text-amber-300 border-amber-700/50 bg-amber-500/10">
              <HelpCircle className="h-3 w-3" />
              Unknown
            </Badge>
          )}
        </TableCell>
      )}

      {/* Stage - only for non-paused rows */}
      {!isPaused && (
        <TableCell>
          <StageChip
            status={request.status}
            autopilotMode={request.autopilot_mode}
            pauseReason={request.pause_reason}
            nextDueAt={request.next_due_at}
          />
        </TableCell>
      )}

      {/* Inbound */}
      <TableCell className={cn(
        "text-sm",
        !request.last_inbound_at && "text-muted-foreground"
      )}>
        {inboundDisplay}
      </TableCell>

      {/* Due with type chip + overdue severity */}
      <TableCell>
        {dueInfo.text ? (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              {dueInfo.typeChip && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                  {dueInfo.typeChip}
                </Badge>
              )}
              <span className={cn(
                "text-sm",
                dueInfo.isOverdue && "text-red-400 font-medium"
              )}>
                {dueInfo.text}
              </span>
            </div>
            {dueInfo.overdueDays && dueInfo.overdueDays > 0 && (
              <span className="text-xs text-red-400 font-medium flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {dueInfo.overdueDays}d overdue
              </span>
            )}
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
