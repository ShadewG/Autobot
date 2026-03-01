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
import { BulkActionBar } from "./bulk-action-bar";
import { FilterPresetBar } from "./filter-preset-bar";
import { GATE_TYPE_LABELS } from "./gate-chip";
import { useSelection } from "@/hooks/use-selection";
import { useFilterPresets, type FilterState } from "@/hooks/use-filter-presets";
import { isUnknownAgency } from "@/lib/utils";
import type { RequestListItem, PauseReason } from "@/lib/types";
import {
  AlertCircle,
  Clock,
  Bot,
  Filter,
  ChevronDown,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface InboxSectionsProps {
  needsDecision: RequestListItem[];
  botWorking: RequestListItem[];
  waitingOnAgency: RequestListItem[];
  completed: RequestListItem[];
  isAdmin?: boolean;
  onApprove: (id: string) => void;
  onAdjust: (id: string) => void;
  onSnooze: (id: string) => void;
  onRepair: (id: string) => void;
  onFollowUp: (id: string) => void;
  onTakeOver: (id: string) => void;
  onGuideAI: (id: string) => void;
  onCancelRun: (id: string) => void;
  onBulkAction: (ids: string[], action: string) => Promise<{ succeeded: number; failed: number }>;
}

// The 6 original human-decision gate types shown in the gate filter dropdown
const HUMAN_GATE_TYPES: PauseReason[] = [
  "FEE_QUOTE",
  "DENIAL",
  "SCOPE",
  "ID_REQUIRED",
  "SENSITIVE",
  "CLOSE_ACTION",
];

export function InboxSections({
  needsDecision,
  botWorking,
  waitingOnAgency,
  completed,
  isAdmin = false,
  onApprove,
  onAdjust,
  onSnooze,
  onRepair,
  onFollowUp,
  onTakeOver,
  onGuideAI,
  onCancelRun,
  onBulkAction,
}: InboxSectionsProps) {
  const [showCompleted, setShowCompleted] = useState(false);

  // Filter state
  const [gateFilters, setGateFilters] = useState<Set<PauseReason>>(new Set());
  const [showOnlyOverdue, setShowOnlyOverdue] = useState(false);
  const [waitingSubFilter, setWaitingSubFilter] = useState<"all" | "scheduled" | "no_response">("all");
  const [showOnlyUnknownAgency, setShowOnlyUnknownAgency] = useState(false);
  const [showOnlyOutOfSync, setShowOnlyOutOfSync] = useState(false);

  // Filter presets
  const {
    presets,
    activePresetId,
    selectPreset,
    deleteCustomPreset,
    getFilterState,
  } = useFilterPresets();

  // Apply preset when selected
  const applyPreset = (presetId: string | null) => {
    selectPreset(presetId);
    if (presetId === null) {
      // Clear filters
      setGateFilters(new Set());
      setShowOnlyOverdue(false);
      setWaitingSubFilter("all");
      setShowOnlyUnknownAgency(false);
      setShowOnlyOutOfSync(false);
      return;
    }
    const state = getFilterState();
    if (!state) return;
    // Defer to next tick so getFilterState picks up the new activePresetId
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setGateFilters(new Set(preset.filter.gateTypes));
    setShowOnlyOverdue(preset.filter.showOnlyOverdue);
    setWaitingSubFilter(preset.filter.waitingSubFilter);
    setShowOnlyUnknownAgency(preset.filter.showOnlyUnknownAgency);
    setShowOnlyOutOfSync(preset.filter.showOnlyOutOfSync);
  };

  // Selection for bulk actions
  const allIds = useMemo(
    () => [...needsDecision, ...botWorking, ...waitingOnAgency].map((r) => r.id),
    [needsDecision, botWorking, waitingOnAgency]
  );
  const { selected, toggle, toggleAll, deselectAll, count: selectedCount } = useSelection(allIds);

  // Count overdue items
  const overdueCount = useMemo(() => {
    const now = new Date();
    return [...needsDecision, ...waitingOnAgency].filter((r) => {
      if (!r.next_due_at) return false;
      return new Date(r.next_due_at) < now;
    }).length;
  }, [needsDecision, waitingOnAgency]);

  // Waiting sub-filter counts
  const { scheduledCount, noResponseCount } = useMemo(() => {
    const now = new Date();
    let sched = 0;
    let noResp = 0;
    for (const r of waitingOnAgency) {
      if (
        r.due_info?.due_type === "FOLLOW_UP" &&
        r.next_due_at &&
        new Date(r.next_due_at) > now
      ) {
        sched++;
      } else if (!r.last_inbound_at) {
        noResp++;
      }
    }
    return { scheduledCount: sched, noResponseCount: noResp };
  }, [waitingOnAgency]);

  // Apply filters
  const applyCommonFilters = (items: RequestListItem[]): RequestListItem[] => {
    let result = items;
    if (showOnlyOverdue) {
      const now = new Date();
      result = result.filter((r) => r.next_due_at && new Date(r.next_due_at) < now);
    }
    if (showOnlyUnknownAgency) {
      result = result.filter((r) => isUnknownAgency(r));
    }
    if (showOnlyOutOfSync) {
      result = result.filter((r) => (r.control_mismatches?.length ?? 0) > 0);
    }
    return result;
  };

  const filteredNeedsDecision = useMemo(() => {
    let items = needsDecision;
    if (gateFilters.size > 0) {
      items = items.filter((r) => r.pause_reason && gateFilters.has(r.pause_reason));
    }
    return applyCommonFilters(items);
  }, [needsDecision, gateFilters, showOnlyOverdue, showOnlyUnknownAgency, showOnlyOutOfSync]);

  const filteredBotWorking = useMemo(() => {
    return applyCommonFilters(botWorking);
  }, [botWorking, showOnlyOverdue, showOnlyUnknownAgency, showOnlyOutOfSync]);

  const filteredWaiting = useMemo(() => {
    let items = waitingOnAgency;

    // Sub-filter
    if (waitingSubFilter === "scheduled") {
      const now = new Date();
      items = items.filter(
        (r) =>
          r.due_info?.due_type === "FOLLOW_UP" &&
          r.next_due_at &&
          new Date(r.next_due_at) > now
      );
    } else if (waitingSubFilter === "no_response") {
      items = items.filter((r) => !r.last_inbound_at);
    }

    return applyCommonFilters(items);
  }, [waitingOnAgency, waitingSubFilter, showOnlyOverdue, showOnlyUnknownAgency, showOnlyOutOfSync]);

  // Gate type counts for filter dropdown
  const gateTypeCounts = useMemo(() => {
    const counts: Partial<Record<PauseReason, number>> = {};
    needsDecision.forEach((r) => {
      if (r.pause_reason) {
        counts[r.pause_reason] = (counts[r.pause_reason] || 0) + 1;
      }
    });
    return counts;
  }, [needsDecision]);

  const toggleGateFilter = (gate: PauseReason) => {
    setGateFilters((prev) => {
      const next = new Set(prev);
      if (next.has(gate)) next.delete(gate);
      else next.add(gate);
      return next;
    });
  };

  const hasFilters =
    gateFilters.size > 0 ||
    showOnlyOverdue ||
    waitingSubFilter !== "all" ||
    showOnlyUnknownAgency ||
    showOnlyOutOfSync;

  const clearFilters = () => {
    setGateFilters(new Set());
    setShowOnlyOverdue(false);
    setWaitingSubFilter("all");
    setShowOnlyUnknownAgency(false);
    setShowOnlyOutOfSync(false);
    selectPreset(null);
  };

  const handleBulk = async (action: string) => {
    return onBulkAction(Array.from(selected), action);
  };

  return (
    <div className="space-y-6">
      {/* Preset Bar */}
      <FilterPresetBar
        presets={presets}
        activePresetId={activePresetId}
        onSelectPreset={applyPreset}
        onDeletePreset={deleteCustomPreset}
      />

      {/* Filters Bar */}
      <div className="flex items-center gap-3 flex-wrap">
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
            {HUMAN_GATE_TYPES.map((gate) => {
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
            onClick={clearFilters}
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Needs Decision Section */}
      <Card className="border-amber-700/50 bg-amber-500/10">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertCircle className="h-5 w-5 text-amber-400" />
            Needs Decision ({filteredNeedsDecision.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RequestTable
            requests={filteredNeedsDecision}
            variant="needs_decision"
            isAdmin={isAdmin}
            onApprove={onApprove}
            onAdjust={onAdjust}
            onSnooze={onSnooze}
            onRepair={onRepair}
            onGuideAI={onGuideAI}
            onTakeOver={onTakeOver}
            selectedIds={selected}
            onToggleSelect={toggle}
            onToggleSelectAll={toggleAll}
          />
        </CardContent>
      </Card>

      {/* Bot Working Section */}
      {filteredBotWorking.length > 0 && (
        <Card className="border-blue-700/50 bg-blue-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Bot className="h-5 w-5 text-blue-400" />
              Bot Working ({filteredBotWorking.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RequestTable
              requests={filteredBotWorking}
              variant="bot_working"
              isAdmin={isAdmin}
              onRepair={onRepair}
              onCancelRun={onCancelRun}
              selectedIds={selected}
              onToggleSelect={toggle}
              onToggleSelectAll={toggleAll}
            />
          </CardContent>
        </Card>
      )}

      {/* Waiting on Agency Section */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Clock className="h-5 w-5 text-slate-500" />
              Waiting on Agency ({filteredWaiting.length})
            </CardTitle>
            {/* Sub-filter toggles */}
            <div className="flex items-center gap-1">
              <Button
                variant={waitingSubFilter === "all" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setWaitingSubFilter("all")}
              >
                All
              </Button>
              <Button
                variant={waitingSubFilter === "scheduled" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setWaitingSubFilter("scheduled")}
              >
                Scheduled ({scheduledCount})
              </Button>
              <Button
                variant={waitingSubFilter === "no_response" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setWaitingSubFilter("no_response")}
              >
                No Response ({noResponseCount})
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <RequestTable
            requests={filteredWaiting}
            variant="waiting"
            isAdmin={isAdmin}
            onRepair={onRepair}
            onFollowUp={onFollowUp}
            onTakeOver={onTakeOver}
            selectedIds={selected}
            onToggleSelect={toggle}
            onToggleSelectAll={toggleAll}
          />
        </CardContent>
      </Card>

      {/* Completed Section — collapsed by default */}
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
              <RequestTable requests={completed} variant="completed" isAdmin={isAdmin} onRepair={onRepair} />
            </CardContent>
          )}
        </Card>
      )}

      {/* Bulk Action Bar */}
      <BulkActionBar
        selectedCount={selectedCount}
        selectedIds={selected}
        onDeselectAll={deselectAll}
        onBulkAction={handleBulk}
      />
    </div>
  );
}
