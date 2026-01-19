"use client";

import { useRouter } from "next/navigation";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./status-badge";
import { PauseReasonBadge } from "./pause-reason-badge";
import { AutopilotChip } from "./autopilot-chip";
import { AtRiskBadge } from "./at-risk-badge";
import { DueCountdown } from "./due-countdown";
import { CostDisplay } from "./cost-display";
import type { RequestListItem } from "@/lib/types";
import { formatRelativeTime, truncate } from "@/lib/utils";
import { Check, Edit, Clock } from "lucide-react";

interface RequestRowProps {
  request: RequestListItem;
  showQuickActions?: boolean;
  onApprove?: (id: string) => void;
  onAdjust?: (id: string) => void;
  onSnooze?: (id: string) => void;
}

export function RequestRow({
  request,
  showQuickActions = false,
  onApprove,
  onAdjust,
  onSnooze,
}: RequestRowProps) {
  const router = useRouter();

  const handleClick = () => {
    router.push(`/dashboard/requests/${request.id}`);
  };

  return (
    <TableRow
      className="cursor-pointer"
      onClick={handleClick}
    >
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          {request.at_risk && <AtRiskBadge />}
          <span>{request.id}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium">{truncate(request.subject, 40)}</span>
          <span className="text-sm text-muted-foreground">
            {request.agency_name}, {request.state}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge status={request.status} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatRelativeTime(request.last_inbound_at)}
      </TableCell>
      <TableCell>
        <DueCountdown dueAt={request.next_due_at} />
      </TableCell>
      <TableCell>
        <CostDisplay status={request.cost_status} amount={request.cost_amount} />
      </TableCell>
      <TableCell>
        <AutopilotChip mode={request.autopilot_mode} />
      </TableCell>
      {showQuickActions && (
        <>
          <TableCell>
            {request.pause_reason && (
              <PauseReasonBadge reason={request.pause_reason} />
            )}
          </TableCell>
          <TableCell onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onApprove?.(request.id)}
                title="Approve"
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onAdjust?.(request.id)}
                title="Adjust"
              >
                <Edit className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSnooze?.(request.id)}
                title="Snooze"
              >
                <Clock className="h-4 w-4" />
              </Button>
            </div>
          </TableCell>
        </>
      )}
    </TableRow>
  );
}
