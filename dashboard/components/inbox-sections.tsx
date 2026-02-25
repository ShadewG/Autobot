"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RequestTable } from "./request-table";
import { GATE_TYPE_LABELS } from "./gate-chip";
import type { RequestListItem, PauseReason } from "@/lib/types";
import { AlertCircle, Clock, CalendarClock, Filter, ChevronDown, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface InboxSectionsProps {
  paused: RequestListItem[];
  waiting: RequestListItem[];
  scheduled: RequestListItem[];
  completed: RequestListItem[];
  onApprove: (id: string) => void;
  onAdjust: (id: string) => void;
  onSnooze: (id: string) => void;
}

export function InboxSections({
  paused,
  waiting,
  scheduled,
  completed,
  onApprove,
  onAdjust,
  onSnooze,
}: InboxSectionsProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  // Filter state
  const [gateFilters, setGateFilters] = useState<Set<PauseReason>>(new Set());
  const [showOnlyOverdue, setShowOnlyOverdue] = useState(false);

  // Count overdue items
  const overdueCount = useMemo(() => {
    const now = new Date();
    return [...paused, ...waiting, ...scheduled].filter((r) => {
      if (!r.next_due_at) return false;
      return new Date(r.next_due_at) < now;
    }).length;
  }, [paused, waiting, scheduled]);

  // Filter paused by gate type
  const filteredPaused = useMemo(() => {
    let items = paused;
    if (gateFilters.size > 0) {
      items = items.filter((r) => r.pause_reason && gateFilters.has(r.pause_reason));
    }
    if (showOnlyOverdue) {
      const now = new Date();
      items = items.filter((r) => r.next_due_at && new Date(r.next_due_at) < now);
    }
    return items;
  }, [paused, gateFilters, showOnlyOverdue]);

  // Filter waiting/scheduled by overdue only
  const filteredWaiting = useMemo(() => {
    if (!showOnlyOverdue) return waiting;
    const now = new Date();
    return waiting.filter((r) => r.next_due_at && new Date(r.next_due_at) < now);
  }, [waiting, showOnlyOverdue]);

  const filteredScheduled = useMemo(() => {
    if (!showOnlyOverdue) return scheduled;
    const now = new Date();
    return scheduled.filter((r) => r.next_due_at && new Date(r.next_due_at) < now);
  }, [scheduled, showOnlyOverdue]);

  // Get gate type counts for filter dropdown
  const gateTypeCounts = useMemo(() => {
    const counts: Partial<Record<PauseReason, number>> = {};
    paused.forEach((r) => {
      if (r.pause_reason) {
        counts[r.pause_reason] = (counts[r.pause_reason] || 0) + 1;
      }
    });
    return counts;
  }, [paused]);

  const toggleGateFilter = (gate: PauseReason) => {
    setGateFilters((prev) => {
      const next = new Set(prev);
      if (next.has(gate)) {
        next.delete(gate);
      } else {
        next.add(gate);
      }
      return next;
    });
  };

  const hasFilters = gateFilters.size > 0 || showOnlyOverdue;

  return (
    <div className="space-y-6">
      {/* Filters Bar */}
      <div className="flex items-center gap-3">
        {/* Gate Type Filter */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <Filter className="h-3.5 w-3.5 mr-1.5" />
              Gate Type
              {gateFilters.size > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-5 px-1.5">
                  {gateFilters.size}
                </Badge>
              )}
              <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(Object.keys(GATE_TYPE_LABELS) as PauseReason[]).map((gate) => {
              const count = gateTypeCounts[gate] || 0;
              return (
                <DropdownMenuCheckboxItem
                  key={gate}
                  checked={gateFilters.has(gate)}
                  onCheckedChange={() => toggleGateFilter(gate)}
                  disabled={count === 0}
                >
                  {GATE_TYPE_LABELS[gate]}
                  {count > 0 && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {count}
                    </span>
                  )}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Overdue Toggle */}
        <Button
          variant={showOnlyOverdue ? "default" : "outline"}
          size="sm"
          className="h-8"
          onClick={() => setShowOnlyOverdue(!showOnlyOverdue)}
        >
          <Clock className="h-3.5 w-3.5 mr-1.5" />
          Overdue only
          {overdueCount > 0 && (
            <Badge
              variant={showOnlyOverdue ? "secondary" : "destructive"}
              className="ml-1.5 h-5 px-1.5"
            >
              {overdueCount}
            </Badge>
          )}
        </Button>

        {/* Clear Filters */}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setGateFilters(new Set());
              setShowOnlyOverdue(false);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Paused Section */}
      <Card className="border-amber-700/50 bg-amber-500/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertCircle className="h-5 w-5 text-amber-400" />
            Paused — Needs Human ({filteredPaused.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestTable
            requests={filteredPaused}
            variant="paused"
            onApprove={onApprove}
            onAdjust={onAdjust}
            onSnooze={onSnooze}
          />
        </CardContent>
      </Card>

      {/* Waiting on Agency Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="h-5 w-5 text-slate-500" />
            Waiting on Agency ({filteredWaiting.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestTable requests={filteredWaiting} variant="waiting" />
        </CardContent>
      </Card>

      {/* Scheduled Actions Section - only show if there are items */}
      {filteredScheduled.length > 0 && (
        <Card className="border-blue-700/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarClock className="h-5 w-5 text-blue-500" />
              Scheduled Actions ({filteredScheduled.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RequestTable requests={filteredScheduled} variant="scheduled" />
          </CardContent>
        </Card>
      )}

      {/* Completed Section - collapsed by default */}
      {completed.length > 0 && (
        <Card className="border-emerald-700/30 bg-emerald-500/5">
          <CardHeader className="pb-3">
            <CardTitle
              className="flex items-center gap-2 text-lg cursor-pointer select-none"
              onClick={() => setShowCompleted(!showCompleted)}
            >
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              Completed ({completed.length})
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  showCompleted && "rotate-180"
                )}
              />
            </CardTitle>
          </CardHeader>
          {showCompleted && (
            <CardContent>
              <RequestTable requests={completed} variant="completed" />
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
