"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DeadlineMilestone, StateDeadline } from "@/lib/types";
import { formatDate, cn } from "@/lib/utils";
import {
  Calendar,
  Clock,
  CheckCircle,
  AlertTriangle,
  XCircle,
  HelpCircle,
} from "lucide-react";

interface DeadlineCalculatorProps {
  milestones?: DeadlineMilestone[];
  stateDeadline?: StateDeadline;
  className?: string;
  compact?: boolean; // Compact mode for embedding in other cards
}

export function DeadlineCalculator({
  milestones,
  stateDeadline,
  className,
  compact = false,
}: DeadlineCalculatorProps) {
  if (!milestones || milestones.length === 0) {
    return null;
  }

  // Find key milestones
  const submitted = milestones.find((m) => m.type === "SUBMITTED");
  const statutoryDue = milestones.find((m) => m.type === "STATUTORY_DUE");

  // Determine overall timeline status
  const now = new Date();
  const isOverdue =
    statutoryDue && new Date(statutoryDue.date) < now;
  const isAtRisk =
    statutoryDue &&
    !isOverdue &&
    new Date(statutoryDue.date).getTime() - now.getTime() < 48 * 60 * 60 * 1000;
  const isToday =
    statutoryDue &&
    new Date(statutoryDue.date).toDateString() === now.toDateString();

  // Get milestone icon and color
  const getMilestoneDisplay = (milestone: DeadlineMilestone) => {
    const isPast = new Date(milestone.date) < now;
    const isStatutory = milestone.type === "STATUTORY_DUE";

    // For statutory due date
    if (isStatutory) {
      if (isOverdue) {
        return {
          icon: XCircle,
          color: "text-red-400",
          bgColor: "bg-red-500/15",
          status: "Overdue",
        };
      }
      if (isToday) {
        return {
          icon: AlertTriangle,
          color: "text-amber-400",
          bgColor: "bg-amber-500/15",
          status: "Due Today!",
        };
      }
      if (isAtRisk) {
        return {
          icon: AlertTriangle,
          color: "text-amber-400",
          bgColor: "bg-amber-500/15",
          status: "At Risk",
        };
      }
      return {
        icon: Clock,
        color: "text-blue-400",
        bgColor: "bg-blue-500/15",
        status: "Upcoming",
      };
    }

    // For past milestones with deadline compliance check
    if (isPast) {
      if (milestone.is_met === true) {
        return {
          icon: CheckCircle,
          color: "text-green-400",
          bgColor: "bg-green-500/15",
          status: "On Time",
        };
      }
      if (milestone.is_met === false) {
        return {
          icon: XCircle,
          color: "text-red-400",
          bgColor: "bg-red-500/15",
          status: "Late",
        };
      }
      return {
        icon: CheckCircle,
        color: "text-muted-foreground",
        bgColor: "bg-muted",
        status: "Completed",
      };
    }

    return {
      icon: HelpCircle,
      color: "text-muted-foreground",
      bgColor: "bg-muted",
      status: "Pending",
    };
  };

  // Compact version: just progress bar and key dates
  if (compact) {
    return (
      <div className={cn("space-y-2", className)}>
        {/* Visual timeline bar */}
        {submitted && statutoryDue && (
          <div className="relative">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>{formatDate(submitted.date)}</span>
              <span className={cn(
                isOverdue ? "text-red-400 font-medium" : isAtRisk ? "text-amber-400 font-medium" : ""
              )}>
                {formatDate(statutoryDue.date)}
                {isOverdue && " (overdue)"}
                {isToday && " (today!)"}
              </span>
            </div>
            <div className="relative h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  "absolute left-0 top-0 h-full rounded-full transition-all",
                  isOverdue ? "bg-red-500" : isAtRisk ? "bg-amber-500" : "bg-green-500"
                )}
                style={{
                  width: isOverdue
                    ? "100%"
                    : `${Math.min(
                        100,
                        ((now.getTime() - new Date(submitted.date).getTime()) /
                          (new Date(statutoryDue.date).getTime() -
                            new Date(submitted.date).getTime())) *
                          100
                      )}%`,
                }}
              />
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-gray-600 rounded-full border-2 border-white" />
              <div
                className={cn(
                  "absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white",
                  isOverdue ? "bg-red-600" : isAtRisk ? "bg-amber-600" : "bg-blue-600"
                )}
              />
            </div>
          </div>
        )}
        {/* Compact milestone list */}
        <div className="flex flex-wrap gap-2 text-xs">
          {milestones.map((milestone, index) => {
            const display = getMilestoneDisplay(milestone);
            const Icon = display.icon;
            return (
              <div
                key={index}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded",
                  display.bgColor
                )}
              >
                <Icon className={cn("h-3 w-3", display.color)} />
                <span className="text-muted-foreground">{milestone.label.split(' ')[0]}</span>
                <span className={cn("font-medium", display.color)}>{display.status}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Full version with card wrapper
  return (
    <Card className={cn("", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Timeline
          {stateDeadline && (
            <Badge variant="outline" className="text-[10px] font-normal ml-auto">
              {stateDeadline.state_code} - {stateDeadline.response_days} business days
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Visual timeline bar */}
        {submitted && statutoryDue && (
          <div className="relative">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>{formatDate(submitted.date)}</span>
              <span>{formatDate(statutoryDue.date)}</span>
            </div>
            <div className="relative h-2 bg-muted rounded-full overflow-hidden">
              {/* Progress indicator */}
              <div
                className={cn(
                  "absolute left-0 top-0 h-full rounded-full transition-all",
                  isOverdue ? "bg-red-500" : isAtRisk ? "bg-amber-500" : "bg-green-500"
                )}
                style={{
                  width: isOverdue
                    ? "100%"
                    : `${Math.min(
                        100,
                        ((now.getTime() - new Date(submitted.date).getTime()) /
                          (new Date(statutoryDue.date).getTime() -
                            new Date(submitted.date).getTime())) *
                          100
                      )}%`,
                }}
              />
              {/* Start marker */}
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-gray-600 rounded-full border-2 border-white" />
              {/* End marker */}
              <div
                className={cn(
                  "absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white",
                  isOverdue ? "bg-red-600" : isAtRisk ? "bg-amber-600" : "bg-blue-600"
                )}
              />
            </div>
          </div>
        )}

        <Separator />

        {/* Milestone list */}
        <div className="space-y-2">
          {milestones.map((milestone, index) => {
            const display = getMilestoneDisplay(milestone);
            const Icon = display.icon;
            const isPast = new Date(milestone.date) < now;

            return (
              <div
                key={index}
                className={cn(
                  "flex items-start gap-2 py-1.5 px-2 rounded text-sm",
                  display.bgColor
                )}
              >
                <Icon className={cn("h-4 w-4 mt-0.5", display.color)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-xs">
                      {formatDate(milestone.date)}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {milestone.label}
                    </span>
                  </div>
                  {/* Days info */}
                  {milestone.days_from_prior !== undefined && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-[10px] text-muted-foreground cursor-help">
                          {milestone.days_from_prior} days
                          {milestone.statutory_limit &&
                            ` (limit: ${milestone.statutory_limit})`}
                          {milestone.is_met !== undefined && (
                            <span
                              className={cn(
                                "ml-1",
                                milestone.is_met ? "text-green-400" : "text-red-400"
                              )}
                            >
                              — {milestone.is_met ? "on time" : "late"}
                            </span>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          {milestone.days_from_prior} business days from prior milestone
                          {milestone.statutory_limit &&
                            `. Statutory limit: ${milestone.statutory_limit} days`}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                {/* Status badge */}
                <Badge
                  variant="outline"
                  className={cn("text-[10px] shrink-0", display.color)}
                >
                  {display.status}
                </Badge>
              </div>
            );
          })}
        </div>

        {/* Statute citation */}
        {stateDeadline?.statute_citation && (
          <>
            <Separator />
            <p className="text-[10px] text-muted-foreground">
              {stateDeadline.statute_citation}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Compact inline deadline display
interface DeadlineStatusProps {
  milestones?: DeadlineMilestone[];
  stateDeadline?: StateDeadline;
}

export function DeadlineStatus({ milestones, stateDeadline }: DeadlineStatusProps) {
  if (!milestones || milestones.length === 0) return null;

  const statutoryDue = milestones.find((m) => m.type === "STATUTORY_DUE");
  if (!statutoryDue) return null;

  const now = new Date();
  const dueDate = new Date(statutoryDue.date);
  const isOverdue = dueDate < now;
  const daysRemaining = Math.ceil(
    (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  return (
    <div className="flex items-center gap-1.5 text-xs">
      {isOverdue ? (
        <>
          <XCircle className="h-3 w-3 text-red-400" />
          <span className="text-red-400 font-medium">
            {Math.abs(daysRemaining)}d overdue
          </span>
        </>
      ) : daysRemaining <= 2 ? (
        <>
          <AlertTriangle className="h-3 w-3 text-amber-400" />
          <span className="text-amber-400 font-medium">
            {daysRemaining === 0 ? "Due today" : `${daysRemaining}d left`}
          </span>
        </>
      ) : (
        <>
          <Clock className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">{daysRemaining}d remaining</span>
        </>
      )}
      {stateDeadline && (
        <span className="text-muted-foreground">
          ({stateDeadline.state_code} {stateDeadline.response_days}d)
        </span>
      )}
    </div>
  );
}
