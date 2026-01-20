"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RequestStatus, PauseReason, AutopilotMode } from "@/lib/types";
import { PAUSE_REASON_LABELS } from "@/lib/utils";
import {
  Pause,
  Play,
  Eye,
  Hand,
  DollarSign,
  Scale,
  Ban,
  UserCheck,
  AlertTriangle,
  CheckCircle
} from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<RequestStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  DRAFT: { label: "Draft", variant: "outline" },
  READY_TO_SEND: { label: "Ready to Send", variant: "secondary" },
  AWAITING_RESPONSE: { label: "Awaiting Response", variant: "default" },
  RECEIVED_RESPONSE: { label: "Response Received", variant: "default" },
  CLOSED: { label: "Closed", variant: "outline" },
  NEEDS_HUMAN_REVIEW: { label: "Needs Review", variant: "destructive" },
};

const PAUSE_ICON: Record<PauseReason, React.ComponentType<{ className?: string }>> = {
  FEE_QUOTE: DollarSign,
  SCOPE: Scale,
  DENIAL: Ban,
  ID_REQUIRED: UserCheck,
  SENSITIVE: AlertTriangle,
  CLOSE_ACTION: CheckCircle,
};

const MODE_CONFIG: Record<AutopilotMode, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  AUTO: { label: "Auto", icon: Play, color: "text-green-600" },
  SUPERVISED: { label: "Supervised", icon: Eye, color: "text-yellow-600" },
  MANUAL: { label: "Manual", icon: Hand, color: "text-gray-600" },
};

interface GateStatusChipsProps {
  status: RequestStatus;
  pauseReason: PauseReason | null;
  autopilotMode: AutopilotMode;
  requiresHuman: boolean;
  blockedReason?: string;
  className?: string;
}

export function GateStatusChips({
  status,
  pauseReason,
  autopilotMode,
  requiresHuman,
  blockedReason,
  className,
}: GateStatusChipsProps) {
  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.AWAITING_RESPONSE;
  const modeConfig = MODE_CONFIG[autopilotMode];
  const ModeIcon = modeConfig.icon;

  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      {/* Gate chip - only show if paused */}
      {requiresHuman && pauseReason && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="destructive"
              className="gap-1 bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-yellow-300"
            >
              <Pause className="h-3 w-3" />
              PAUSED — {PAUSE_REASON_LABELS[pauseReason]}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p>Requires human decision before proceeding</p>
            {blockedReason && <p className="text-xs mt-1">{blockedReason}</p>}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Mode chip */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1">
            <ModeIcon className={cn("h-3 w-3", modeConfig.color)} />
            {modeConfig.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {autopilotMode === 'AUTO' && "AI can execute actions automatically"}
          {autopilotMode === 'SUPERVISED' && "AI proposes actions for human approval"}
          {autopilotMode === 'MANUAL' && "Human controls all actions"}
        </TooltipContent>
      </Tooltip>

      {/* Status chip */}
      <Badge variant={statusConfig.variant}>
        {statusConfig.label}
      </Badge>
    </div>
  );
}
