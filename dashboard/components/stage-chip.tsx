"use client";

import { Badge } from "@/components/ui/badge";
import { Clock, Mail, Globe, CheckCircle, PauseCircle, CalendarClock } from "lucide-react";
import type { RequestStatus, AutopilotMode, PauseReason } from "@/lib/types";
import { cn } from "@/lib/utils";

interface StageChipProps {
  status: RequestStatus;
  autopilotMode: AutopilotMode;
  pauseReason?: PauseReason | null;
  channel?: "EMAIL" | "PORTAL" | "MAIL";
  nextDueAt?: string | null;
  className?: string;
}

type StageType =
  | "waiting_email"
  | "waiting_portal"
  | "scheduled"
  | "paused"
  | "completed"
  | "draft";

interface StageConfig {
  label: string;
  icon: React.ReactNode;
  variant: "default" | "secondary" | "outline" | "destructive";
  className?: string;
}

const STAGE_CONFIG: Record<StageType, StageConfig> = {
  waiting_email: {
    label: "Waiting (email)",
    icon: <Mail className="h-3 w-3" />,
    variant: "secondary",
  },
  waiting_portal: {
    label: "Waiting (portal)",
    icon: <Globe className="h-3 w-3" />,
    variant: "secondary",
  },
  scheduled: {
    label: "Follow-up scheduled",
    icon: <CalendarClock className="h-3 w-3" />,
    variant: "outline",
  },
  paused: {
    label: "Paused",
    icon: <PauseCircle className="h-3 w-3" />,
    variant: "destructive",
  },
  completed: {
    label: "Completed",
    icon: <CheckCircle className="h-3 w-3" />,
    variant: "outline",
    className: "text-green-300 border-green-700/50",
  },
  draft: {
    label: "Draft",
    icon: <Clock className="h-3 w-3" />,
    variant: "outline",
  },
};

function getStageType(
  status: RequestStatus,
  pauseReason?: PauseReason | null,
  channel?: "EMAIL" | "PORTAL" | "MAIL",
  nextDueAt?: string | null
): StageType {
  if (status === "CLOSED") return "completed";
  if (status === "DRAFT" || status === "READY_TO_SEND") return "draft";
  if (status === "NEEDS_HUMAN_REVIEW" || pauseReason) return "paused";

  // Check if there's a scheduled follow-up
  if (nextDueAt) {
    const dueDate = new Date(nextDueAt);
    const now = new Date();
    if (dueDate > now) return "scheduled";
  }

  // Default to waiting based on channel
  if (channel === "PORTAL") return "waiting_portal";
  return "waiting_email";
}

export function StageChip({
  status,
  autopilotMode,
  pauseReason,
  channel,
  nextDueAt,
  className,
}: StageChipProps) {
  const stageType = getStageType(status, pauseReason, channel, nextDueAt);
  const config = STAGE_CONFIG[stageType];

  return (
    <Badge
      variant={config.variant}
      className={cn("gap-1 font-normal", config.className, className)}
    >
      {config.icon}
      <span>{config.label}</span>
    </Badge>
  );
}
