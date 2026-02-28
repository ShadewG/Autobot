"use client";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { RequestRow } from "./request-row";
import type { RequestListItem } from "@/lib/types";

export type TableVariant = "needs_decision" | "bot_working" | "waiting" | "completed";

interface RequestTableProps {
  requests: RequestListItem[];
  variant?: TableVariant;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
  onRepair?: (id: string) => void;
  onFollowUp?: (id: string) => void;
  onTakeOver?: (id: string) => void;
  onGuideAI?: (id: string) => void;
  onCancelRun?: (id: string) => void;
  // Selection
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: (ids: string[]) => void;
}

export function RequestTable({
  requests,
  variant = "waiting",
  onApprove,
  onAdjust,
  onSnooze,
  onRepair,
  onFollowUp,
  onTakeOver,
  onGuideAI,
  onCancelRun,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: RequestTableProps) {
  if (requests.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No requests found
      </div>
    );
  }

  const isNeedsDecision = variant === "needs_decision";
  const isCompleted = variant === "completed";
  const hasSelection = selectedIds !== undefined && onToggleSelect !== undefined;

  const allIds = requests.map((r) => r.id);
  const allSelected = hasSelection && allIds.every((id) => selectedIds.has(id));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {hasSelection && (
            <TableHead className="w-[40px]">
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => onToggleSelectAll?.(allIds)}
                aria-label="Select all"
              />
            </TableHead>
          )}
          <TableHead className="w-[70px]">ID</TableHead>
          <TableHead className="min-w-[220px]">Subject / Agency</TableHead>
          {isCompleted ? (
            <TableHead className="w-[130px]">Outcome</TableHead>
          ) : isNeedsDecision ? (
            <TableHead className="w-[130px]">Gate</TableHead>
          ) : (
            <TableHead className="w-[110px]">Stage</TableHead>
          )}
          {isCompleted ? (
            <TableHead className="min-w-[200px]">Summary</TableHead>
          ) : (
            <TableHead className="w-[90px]">Inbound</TableHead>
          )}
          <TableHead className={isCompleted ? "w-[100px]" : "w-[130px]"}>
            {isCompleted ? "Closed" : "Due"}
          </TableHead>
          <TableHead className="w-[80px]">Cost</TableHead>
          <TableHead className="w-[140px] text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {requests.map((request) => (
          <RequestRow
            key={request.id}
            request={request}
            variant={variant}
            onApprove={onApprove}
            onAdjust={onAdjust}
            onSnooze={onSnooze}
            onRepair={onRepair}
            onFollowUp={onFollowUp}
            onTakeOver={onTakeOver}
            onGuideAI={onGuideAI}
            onCancelRun={onCancelRun}
            isSelected={selectedIds?.has(request.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </TableBody>
    </Table>
  );
}
