"use client";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RequestRow } from "./request-row";
import type { RequestListItem } from "@/lib/types";

export type TableVariant = "paused" | "waiting" | "scheduled" | "completed";

interface RequestTableProps {
  requests: RequestListItem[];
  variant?: TableVariant;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
}

export function RequestTable({
  requests,
  variant = "waiting",
  onApprove,
  onAdjust,
  onSnooze,
}: RequestTableProps) {
  if (requests.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No requests found
      </div>
    );
  }

  const isPaused = variant === "paused";
  const isCompleted = variant === "completed";

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[70px]">ID</TableHead>
          <TableHead className="min-w-[220px]">Subject / Agency</TableHead>
          {isCompleted ? (
            <TableHead className="w-[130px]">Outcome</TableHead>
          ) : isPaused ? (
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
          <TableHead className="w-[100px] text-right">Action</TableHead>
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
          />
        ))}
      </TableBody>
    </Table>
  );
}
