"use client";

import { useState } from "react";
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
import { Eye, ArrowRight, DollarSign, AlertTriangle, HelpCircle, CheckCircle2, XCircle, FileText, Loader2, Wrench, ChevronDown, ChevronUp } from "lucide-react";

interface RequestRowProps {
  request: RequestListItem;
  variant: TableVariant;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
  onRepair?: (id: string) => void;
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

function isRunActive(status: string | null | undefined): boolean {
  if (!status) return false;
  return ["created", "queued", "processing", "waiting", "running"].includes(status.toLowerCase());
}

function formatRunAge(startedAt: string | null | undefined): string | null {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return null;
  const mins = Math.floor((Date.now() - started) / (1000 * 60));
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function deriveNowLine(request: RequestListItem): {
  text: string;
  tone: "blue" | "amber" | "green";
  isRunning: boolean;
} {
  const runActive = isRunActive(request.active_run_status);
  const runAge = formatRunAge(request.active_run_started_at);

  if (request.review_state === "DECISION_APPLYING") {
    return {
      text: runAge ? `Applying your decision (${runAge})` : "Applying your decision",
      tone: "blue",
      isRunning: true,
    };
  }
  if (request.review_state === "PROCESSING" && runActive) {
    return {
      text: runAge ? `Agent working (${runAge})` : "Agent working",
      tone: "blue",
      isRunning: true,
    };
  }
  if (request.review_state === "DECISION_REQUIRED" || request.requires_human) {
    return {
      text: "Decision required",
      tone: "amber",
      isRunning: false,
    };
  }
  if (request.review_state === "WAITING_AGENCY") {
    return {
      text: "Waiting on agency response",
      tone: "green",
      isRunning: false,
    };
  }

  const portalTaskStatus = String(request.active_portal_task_status || "").toLowerCase();
  if (portalTaskStatus === "pending" || portalTaskStatus === "in_progress") {
    return {
      text: "Processing portal submission",
      tone: "blue",
      isRunning: true,
    };
  }

  if (runActive) {
    return {
      text: runAge ? `Agent processing (${runAge})` : "Agent processing",
      tone: "blue",
      isRunning: true,
    };
  }

  return {
    text: "Monitoring case",
    tone: "green",
    isRunning: false,
  };
}

function getStateMismatch(request: RequestListItem): string | null {
  const runActive = isRunActive(request.active_run_status);
  if ((request.review_state === "PROCESSING" || request.review_state === "DECISION_APPLYING") && request.requires_human) {
    return "Marked as needs decision while actively processing";
  }
  if (request.review_state === "DECISION_REQUIRED" && runActive) {
    return "Decision-required case also has an active run";
  }
  if (request.requires_human && !request.pause_reason && request.review_state === "DECISION_REQUIRED") {
    return "Missing review reason";
  }
  return null;
}

function getReviewButtonLabel(request: RequestListItem): string {
  if (request.pause_reason === "FEE_QUOTE") return "Review fee";
  if (request.pause_reason === "DENIAL") return "Review denial";
  if (request.pause_reason === "SCOPE") return "Review scope";
  return "Review";
}

// Outcome badge for completed cases
function OutcomeBadge({ outcomeType }: { outcomeType: string | null }) {
  const config = (() => {
    switch (outcomeType) {
      case "RECORDS_PROVIDED":
        return { label: "Records", icon: FileText, className: "text-emerald-400 border-emerald-700/50 bg-emerald-500/10" };
      case "PARTIAL_RECORDS":
        return { label: "Partial", icon: FileText, className: "text-yellow-400 border-yellow-700/50 bg-yellow-500/10" };
      case "DENIED":
        return { label: "Denied", icon: XCircle, className: "text-red-400 border-red-700/50 bg-red-500/10" };
      case "WITHDRAWN":
        return { label: "Withdrawn", icon: XCircle, className: "text-slate-400 border-slate-700/50 bg-slate-500/10" };
      case "NO_RECORDS":
        return { label: "No Records", icon: XCircle, className: "text-orange-400 border-orange-700/50 bg-orange-500/10" };
      case "FEE_DECLINED":
        return { label: "Fee Declined", icon: DollarSign, className: "text-orange-400 border-orange-700/50 bg-orange-500/10" };
      default:
        return { label: "Closed", icon: CheckCircle2, className: "text-emerald-400 border-emerald-700/50 bg-emerald-500/10" };
    }
  })();

  const Icon = config.icon;
  return (
    <Badge variant="outline" className={cn("gap-1", config.className)}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

export function RequestRow({
  request,
  variant,
  onApprove,
  onAdjust,
  onSnooze,
  onRepair,
}: RequestRowProps) {
  const router = useRouter();
  const [showDetails, setShowDetails] = useState(false);
  const isPaused = variant === "paused";
  const isCompleted = variant === "completed";

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
  const nowLine = deriveNowLine(request);
  const mismatch = getStateMismatch(request);
  const reviewButtonLabel = getReviewButtonLabel(request);
  const activityTime = request.last_activity_at
    ? new Date(request.last_activity_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <TableRow
      className={cn(
        "cursor-pointer transition-colors",
        isPaused && "bg-amber-500/10 hover:bg-amber-500/15"
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
          <span className={cn(
            "text-xs flex items-center gap-1 font-medium",
            nowLine.tone === "blue" && "text-blue-300",
            nowLine.tone === "amber" && "text-amber-300",
            nowLine.tone === "green" && "text-emerald-300"
          )}>
            {nowLine.isRunning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3 w-3" />
            )}
            {nowLine.text}
          </span>
          {mismatch && (
            <span className="text-xs text-red-300 flex items-center gap-1 font-medium">
              <AlertTriangle className="h-3 w-3" />
              {mismatch}
            </span>
          )}
          {showDetails && (
            <div className="text-[11px] text-muted-foreground pt-1 space-y-0.5">
              <p>Case status: {request.status.replace(/_/g, " ")}</p>
              <p>Review state: {request.review_state || "IDLE"}</p>
              {request.active_run_status && <p>Run: {request.active_run_status}</p>}
              {activityTime && <p>Last activity: {activityTime}</p>}
            </div>
          )}
        </div>
      </TableCell>

      {/* Gate for paused, Outcome for completed, Stage for others */}
      {isCompleted ? (
        <TableCell>
          <OutcomeBadge outcomeType={request.outcome_type} />
        </TableCell>
      ) : isPaused ? (
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
      ) : (
        <TableCell>
          <StageChip
            status={request.status}
            autopilotMode={request.autopilot_mode}
            pauseReason={request.pause_reason}
            nextDueAt={request.next_due_at}
          />
        </TableCell>
      )}

      {/* Inbound or Summary for completed */}
      {isCompleted ? (
        <TableCell>
          <span className="text-xs text-muted-foreground line-clamp-2">
            {request.outcome_summary || request.substatus || "Closed"}
          </span>
        </TableCell>
      ) : (
        <TableCell className={cn(
          "text-sm",
          !request.last_inbound_at && "text-muted-foreground"
        )}>
          {inboundDisplay}
        </TableCell>
      )}

      {/* Due / Closed date */}
      <TableCell>
        {isCompleted && request.closed_at ? (
          <span className="text-sm text-muted-foreground">
            {new Date(request.closed_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </span>
        ) : dueInfo.text ? (
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
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setShowDetails((v) => !v)}
            title={showDetails ? "Hide details" : "Show details"}
          >
            {showDetails ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
          {mismatch && onRepair && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs text-amber-300 border-amber-700/50"
              onClick={() => onRepair(request.id)}
            >
              <Wrench className="h-3.5 w-3.5 mr-1" />
              Repair
            </Button>
          )}
          {isPaused ? (
            <Button
              size="sm"
              variant="default"
              className="h-7 px-3"
              onClick={() => onApprove?.(request.id)}
            >
              {reviewButtonLabel}
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
        </div>
      </TableCell>
    </TableRow>
  );
}
