"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StageChip } from "./stage-chip";
import { GateChip } from "./gate-chip";
import { AtRiskBadge } from "./at-risk-badge";
import { WhyHereChip } from "./why-here-chip";
import { HealthIndicator } from "./health-indicator";
import type { RequestListItem } from "@/lib/types";
import type { TableVariant } from "./request-table";
import { formatRelativeTime, truncate, cn, isUnknownAgency } from "@/lib/utils";
import { requestsAPI } from "@/lib/api";
import {
  Eye,
  ArrowRight,
  DollarSign,
  AlertTriangle,
  HelpCircle,
  CheckCircle2,
  XCircle,
  FileText,
  ChevronDown,
  ChevronUp,
  Send,
  Phone,
  MoreHorizontal,
  Pause,
  Compass,
  Wrench,
  Search as SearchIcon,
  ExternalLink,
} from "lucide-react";

interface RequestRowProps {
  request: RequestListItem;
  variant: TableVariant;
  isAdmin?: boolean;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
  onRepair?: (id: string) => void;
  onFollowUp?: (id: string) => void;
  onTakeOver?: (id: string) => void;
  onGuideAI?: (id: string) => void;
  onCancelRun?: (id: string) => void;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
}

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

  return { text: formatted, overdueDays: isOverdue ? diffDays : null, isOverdue, typeChip };
}

function getReviewButtonLabel(request: RequestListItem): string {
  if (request.pause_reason === "FEE_QUOTE") return "Review fee";
  if (request.pause_reason === "DENIAL") return "Review denial";
  if (request.pause_reason === "SCOPE") return "Review scope";
  return "Review";
}

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
  isAdmin = false,
  onApprove,
  onAdjust,
  onSnooze,
  onRepair,
  onFollowUp,
  onTakeOver,
  onGuideAI,
  onCancelRun,
  isSelected,
  onToggleSelect,
}: RequestRowProps) {
  const router = useRouter();
  const [showDetails, setShowDetails] = useState(false);
  const isNeedsDecision = variant === "needs_decision";
  const isBotWorking = variant === "bot_working";
  const isWaiting = variant === "waiting";
  const isCompleted = variant === "completed";
  const hasCheckbox = onToggleSelect !== undefined;

  const handleClick = () => {
    router.push(`/requests/detail?id=${request.id}`);
  };

  const dueInfo = formatDueWithSeverity(request);

  const agencyDisplay =
    request.state && request.state !== "—"
      ? `${request.agency_name}, ${request.state}`
      : request.agency_name;

  const unknownAgency = isUnknownAgency(request);

  const inboundDisplay = request.last_inbound_at
    ? formatRelativeTime(request.last_inbound_at)
    : isWaiting
    ? "No response"
    : "";

  const reviewButtonLabel = getReviewButtonLabel(request);
  const activityTime = request.last_activity_at
    ? new Date(request.last_activity_at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const triggerRunUrl = request.active_run_trigger_run_id
    ? `https://cloud.trigger.dev/orgs/frontwind-llc-27ae/projects/autobot-Z-SQ/env/prod/runs/${request.active_run_trigger_run_id}`
    : null;

  return (
    <TableRow
      className={cn(
        "cursor-pointer transition-colors",
        isNeedsDecision && "bg-amber-500/10 hover:bg-amber-500/15",
        isBotWorking && "bg-blue-500/5 hover:bg-blue-500/10"
      )}
      onClick={handleClick}
    >
      {/* Checkbox */}
      {hasCheckbox && (
        <TableCell
          className="w-[40px]"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect(request.id)}
            aria-label={`Select request ${request.id}`}
          />
        </TableCell>
      )}

      {/* ID with at-risk badge + health indicator */}
      <TableCell className="font-mono text-sm">
        <div className="flex items-center gap-1.5">
          {request.at_risk && <AtRiskBadge />}
          <HealthIndicator
            mismatches={request.control_mismatches}
            onRepair={onRepair ? () => onRepair(request.id) : undefined}
          />
          <span>{request.id}</span>
        </div>
      </TableCell>

      {/* Subject / Agency + WhyHereChip + unknown agency badge */}
      <TableCell>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium truncate max-w-[280px]">
            {truncate(request.subject, 50)}
          </span>
          <span className="text-xs text-muted-foreground">{agencyDisplay}</span>
          {unknownAgency && (
            <Badge
              variant="outline"
              className="w-fit text-[10px] px-1.5 py-0 h-4 text-orange-400 border-orange-700/50"
            >
              Needs resolution
            </Badge>
          )}
          <WhyHereChip request={request} variant={variant} />
          {showDetails && (
            <div className="text-[11px] text-muted-foreground pt-1 space-y-0.5">
              <p>Case status: {request.status.replace(/_/g, " ")}</p>
              <p>Review state: {request.review_state || "IDLE"}</p>
              {request.active_run_status && <p>Run: {request.active_run_status}</p>}
              {isAdmin && triggerRunUrl && (
                <p>
                  Trigger:{" "}
                  <a
                    href={triggerRunUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline inline-flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open run
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              )}
              {activityTime && <p>Last activity: {activityTime}</p>}
            </div>
          )}
        </div>
      </TableCell>

      {/* Gate / Outcome / Stage column */}
      {isCompleted ? (
        <TableCell>
          <OutcomeBadge outcomeType={request.outcome_type} />
        </TableCell>
      ) : isNeedsDecision ? (
        <TableCell>
          {request.pause_reason ? (
            <GateChip reason={request.pause_reason} costAmount={request.cost_amount} />
          ) : (
            <Badge
              variant="outline"
              className="gap-1 text-amber-300 border-amber-700/50 bg-amber-500/10"
            >
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

      {/* Inbound or Summary */}
      {isCompleted ? (
        <TableCell>
          <span className="text-xs text-muted-foreground line-clamp-2">
            {request.outcome_summary || request.substatus || "Closed"}
          </span>
        </TableCell>
      ) : (
        <TableCell
          className={cn("text-sm", !request.last_inbound_at && "text-muted-foreground")}
        >
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
              <span
                className={cn("text-sm", dueInfo.isOverdue && "text-red-400 font-medium")}
              >
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

      {/* Cost */}
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

      {/* Action — variant-specific */}
      <TableCell onClick={(e) => e.stopPropagation()} className="text-right">
        <div className="flex items-center justify-end gap-1.5">
          {/* Toggle details */}
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setShowDetails((v) => !v)}
            title={showDetails ? "Hide details" : "Show details"}
          >
            {showDetails ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>

          {/* Needs Decision: primary = Approve (green), overflow = Guide AI, Take over, Snooze */}
          {isNeedsDecision && (
            <>
              <Button
                size="sm"
                className="h-7 px-3 bg-green-600 hover:bg-green-700 text-white"
                onClick={() => onApprove?.(request.id)}
              >
                {reviewButtonLabel}
                <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-7 w-7">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onGuideAI?.(request.id)}>
                    <Compass className="h-3.5 w-3.5 mr-2" />
                    Guide AI
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onTakeOver?.(request.id)}>
                    <Wrench className="h-3.5 w-3.5 mr-2" />
                    Take over
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onSnooze?.(request.id)}>
                    <Pause className="h-3.5 w-3.5 mr-2" />
                    Snooze
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {/* Waiting: primary = Send follow-up, secondary = Escalate, overflow = Pause, Open, Research */}
          {isWaiting && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 text-xs"
                onClick={() => onFollowUp?.(request.id)}
              >
                <Send className="h-3.5 w-3.5 mr-1" />
                Follow-up
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-7 w-7">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onTakeOver?.(request.id)}>
                    <Phone className="h-3.5 w-3.5 mr-2" />
                    Escalate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onSnooze?.(request.id)}>
                    <Pause className="h-3.5 w-3.5 mr-2" />
                    Pause
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleClick}>
                    <Eye className="h-3.5 w-3.5 mr-2" />
                    Open
                  </DropdownMenuItem>
                  {unknownAgency && (
                    <DropdownMenuItem
                      onClick={() => {
                        requestsAPI.invokeAgent(request.id, "research_agency");
                      }}
                    >
                      <SearchIcon className="h-3.5 w-3.5 mr-2" />
                      Research agency
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {/* Bot Working: primary = Open, overflow = Cancel run */}
          {isBotWorking && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-3"
                onClick={handleClick}
              >
                <Eye className="h-3.5 w-3.5 mr-1" />
                Open
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-7 w-7">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onCancelRun?.(request.id)}>
                    <XCircle className="h-3.5 w-3.5 mr-2" />
                    Cancel run
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          {/* Completed: just Open */}
          {isCompleted && (
            <Button size="sm" variant="ghost" className="h-7 px-3" onClick={handleClick}>
              <Eye className="h-3.5 w-3.5 mr-1" />
              Open
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
