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

interface RequestTableProps {
  requests: RequestListItem[];
  showQuickActions?: boolean;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
}

export function RequestTable({
  requests,
  showQuickActions = false,
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

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[80px]">ID</TableHead>
          <TableHead>Subject / Agency</TableHead>
          <TableHead className="w-[140px]">Status</TableHead>
          <TableHead className="w-[100px]">Inbound</TableHead>
          <TableHead className="w-[80px]">Due</TableHead>
          <TableHead className="w-[80px]">Cost</TableHead>
          <TableHead className="w-[120px]">Autopilot</TableHead>
          {showQuickActions && (
            <>
              <TableHead className="w-[120px]">Pause Reason</TableHead>
              <TableHead className="w-[120px]">Actions</TableHead>
            </>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {requests.map((request) => (
          <RequestRow
            key={request.id}
            request={request}
            showQuickActions={showQuickActions}
            onApprove={onApprove}
            onAdjust={onAdjust}
            onSnooze={onSnooze}
          />
        ))}
      </TableBody>
    </Table>
  );
}
