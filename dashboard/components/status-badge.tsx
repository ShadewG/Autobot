import { Badge } from "@/components/ui/badge";
import type { RequestStatus } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/utils";

const statusVariants: Record<RequestStatus, "default" | "secondary" | "destructive" | "outline" | "warning" | "success" | "info"> = {
  DRAFT: "secondary",
  READY_TO_SEND: "info",
  AWAITING_RESPONSE: "warning",
  RECEIVED_RESPONSE: "success",
  CLOSED: "outline",
  NEEDS_HUMAN_REVIEW: "destructive",
};

interface StatusBadgeProps {
  status: RequestStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <Badge variant={statusVariants[status] || "secondary"}>
      {STATUS_LABELS[status] || status}
    </Badge>
  );
}
