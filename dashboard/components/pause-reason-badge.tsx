import { Badge } from "@/components/ui/badge";
import type { PauseReason } from "@/lib/types";
import { PAUSE_REASON_LABELS } from "@/lib/utils";
import {
  DollarSign,
  FileQuestion,
  XCircle,
  UserCheck,
  AlertTriangle,
  CheckCircle,
} from "lucide-react";

const pauseIcons: Partial<Record<PauseReason, React.ReactNode>> = {
  FEE_QUOTE: <DollarSign className="h-3 w-3" />,
  SCOPE: <FileQuestion className="h-3 w-3" />,
  DENIAL: <XCircle className="h-3 w-3" />,
  ID_REQUIRED: <UserCheck className="h-3 w-3" />,
  SENSITIVE: <AlertTriangle className="h-3 w-3" />,
  CLOSE_ACTION: <CheckCircle className="h-3 w-3" />,
};

interface PauseReasonBadgeProps {
  reason: PauseReason;
}

export function PauseReasonBadge({ reason }: PauseReasonBadgeProps) {
  return (
    <Badge variant="warning" className="gap-1">
      {pauseIcons[reason]}
      {PAUSE_REASON_LABELS[reason] || reason}
    </Badge>
  );
}
