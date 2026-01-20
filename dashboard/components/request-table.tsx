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

export type TableVariant = "paused" | "waiting" | "scheduled";

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

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[70px]">ID</TableHead>
          <TableHead className="min-w-[220px]">Subject / Agency</TableHead>
          {/* Gate for paused, Stage for non-paused */}
          {isPaused ? (
            <TableHead className="w-[130px]">Gate</TableHead>
          ) : (
            <TableHead className="w-[110px]">Stage</TableHead>
          )}
          <TableHead className="w-[90px]">Inbound</TableHead>
          <TableHead className="w-[130px]">Due</TableHead>
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
