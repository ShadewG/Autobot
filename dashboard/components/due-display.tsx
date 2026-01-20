"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DueInfo } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { Clock, AlertTriangle, Calendar, Bell, Pause } from "lucide-react";
import { cn } from "@/lib/utils";

const DUE_TYPE_CONFIG = {
  FOLLOW_UP: {
    label: "Follow-up due",
    icon: Bell,
    color: "text-blue-600",
  },
  STATUTORY: {
    label: "Statutory deadline",
    icon: Calendar,
    color: "text-purple-600",
  },
  AGENCY_PROMISED: {
    label: "Agency promised",
    icon: Clock,
    color: "text-green-600",
  },
  SNOOZED: {
    label: "Snoozed until",
    icon: Pause,
    color: "text-gray-500",
  },
};

interface DueDisplayProps {
  dueInfo?: DueInfo;
  // Fallback for old data format
  nextDueAt?: string | null;
  statutoryDueAt?: string | null;
  compact?: boolean;
}

export function DueDisplay({ dueInfo, nextDueAt, statutoryDueAt, compact = false }: DueDisplayProps) {
  // Build due info from props if not provided
  const info: DueInfo = dueInfo || {
    next_due_at: nextDueAt || null,
    due_type: nextDueAt ? 'FOLLOW_UP' : null,
    statutory_days: null,
    statutory_due_at: statutoryDueAt || null,
    snoozed_until: null,
    is_overdue: nextDueAt ? new Date(nextDueAt) < new Date() : false,
    overdue_days: null,
  };

  // Calculate overdue if not provided
  if (info.next_due_at && !info.overdue_days && info.is_overdue) {
    const dueDate = new Date(info.next_due_at);
    const now = new Date();
    info.overdue_days = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
  }

  if (!info.next_due_at && !info.statutory_due_at) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  const config = info.due_type ? DUE_TYPE_CONFIG[info.due_type] : DUE_TYPE_CONFIG.FOLLOW_UP;
  const Icon = config.icon;

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn("flex items-center gap-1", info.is_overdue && "text-destructive")}>
            {info.is_overdue ? (
              <AlertTriangle className="h-3 w-3" />
            ) : (
              <Icon className={cn("h-3 w-3", config.color)} />
            )}
            <span className="text-sm">
              {info.is_overdue
                ? `Overdue ${info.overdue_days}d`
                : formatDate(info.next_due_at)
              }
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1">
            <p className="font-medium">{config.label}</p>
            {info.statutory_due_at && info.statutory_days && (
              <p className="text-xs">Statutory: {info.statutory_days} biz days</p>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="space-y-1">
      {/* Main due date */}
      <div className={cn(
        "flex items-center gap-2",
        info.is_overdue && "text-destructive"
      )}>
        {info.is_overdue ? (
          <>
            <AlertTriangle className="h-4 w-4" />
            <span className="font-medium">
              Overdue by {info.overdue_days} day{info.overdue_days !== 1 ? 's' : ''}
            </span>
            <Badge variant="destructive" className="text-xs">AT RISK</Badge>
          </>
        ) : (
          <>
            <Icon className={cn("h-4 w-4", config.color)} />
            <span className="text-sm">
              <span className="text-muted-foreground">{config.label}:</span>{" "}
              <span className="font-medium">{formatDate(info.next_due_at)}</span>
            </span>
          </>
        )}
      </div>

      {/* Statutory clock (secondary) */}
      {info.statutory_due_at && info.due_type !== 'STATUTORY' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Calendar className="h-3 w-3" />
          <span>
            Statutory clock: {info.statutory_days ? `${info.statutory_days} biz days` : formatDate(info.statutory_due_at)}
          </span>
        </div>
      )}

      {/* Snoozed indicator */}
      {info.snoozed_until && info.due_type !== 'SNOOZED' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Pause className="h-3 w-3" />
          <span>Snoozed until {formatDate(info.snoozed_until)}</span>
        </div>
      )}
    </div>
  );
}
