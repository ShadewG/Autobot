"use client";

import { Badge } from "@/components/ui/badge";
import {
  DollarSign,
  FileQuestion,
  XCircle,
  UserCheck,
  AlertTriangle,
  CheckSquare,
  Globe,
  Wrench,
  Phone,
  Bot,
  Clock,
  HelpCircle,
  Mail,
} from "lucide-react";
import type { PauseReason } from "@/lib/types";
import { cn } from "@/lib/utils";

interface GateChipProps {
  reason: PauseReason;
  costAmount?: number | null;
  className?: string;
}

interface GateConfig {
  label: string;
  icon: React.ReactNode;
  bgColor: string;
  textColor: string;
}

const GATE_CONFIG: Record<PauseReason, GateConfig> = {
  FEE_QUOTE: {
    label: "Fee Quote",
    icon: <DollarSign className="h-3.5 w-3.5" />,
    bgColor: "bg-amber-500/15",
    textColor: "text-amber-300",
  },
  DENIAL: {
    label: "Denial",
    icon: <XCircle className="h-3.5 w-3.5" />,
    bgColor: "bg-red-500/15",
    textColor: "text-red-300",
  },
  SCOPE: {
    label: "Scope Issue",
    icon: <FileQuestion className="h-3.5 w-3.5" />,
    bgColor: "bg-orange-500/15",
    textColor: "text-orange-300",
  },
  ID_REQUIRED: {
    label: "ID Required",
    icon: <UserCheck className="h-3.5 w-3.5" />,
    bgColor: "bg-blue-500/15",
    textColor: "text-blue-300",
  },
  SENSITIVE: {
    label: "Sensitive",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    bgColor: "bg-purple-500/15",
    textColor: "text-purple-300",
  },
  CLOSE_ACTION: {
    label: "Ready to Close",
    icon: <CheckSquare className="h-3.5 w-3.5" />,
    bgColor: "bg-green-500/15",
    textColor: "text-green-300",
  },
  // Runtime-generated reasons
  proposal_pending: {
    label: "Proposal Pending",
    icon: <Clock className="h-3.5 w-3.5" />,
    bgColor: "bg-sky-500/15",
    textColor: "text-sky-300",
  },
  execution_blocked: {
    label: "Execution Blocked",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    bgColor: "bg-orange-500/15",
    textColor: "text-orange-300",
  },
  email_send_failed: {
    label: "Email Failed",
    icon: <Mail className="h-3.5 w-3.5" />,
    bgColor: "bg-red-500/15",
    textColor: "text-red-300",
  },
  portal_failed: {
    label: "Portal Failed",
    icon: <Wrench className="h-3.5 w-3.5" />,
    bgColor: "bg-red-500/15",
    textColor: "text-red-300",
  },
  portal_timed_out: {
    label: "Portal Timeout",
    icon: <Globe className="h-3.5 w-3.5" />,
    bgColor: "bg-orange-500/15",
    textColor: "text-orange-300",
  },
  escalated: {
    label: "Escalated",
    icon: <Phone className="h-3.5 w-3.5" />,
    bgColor: "bg-yellow-500/15",
    textColor: "text-yellow-300",
  },
  agent_run_failed: {
    label: "Agent Error",
    icon: <Bot className="h-3.5 w-3.5" />,
    bgColor: "bg-red-500/15",
    textColor: "text-red-300",
  },
  stuck_portal_task: {
    label: "Portal Stuck",
    icon: <Wrench className="h-3.5 w-3.5" />,
    bgColor: "bg-orange-500/15",
    textColor: "text-orange-300",
  },
  portal_stuck: {
    label: "Portal Stuck",
    icon: <Wrench className="h-3.5 w-3.5" />,
    bgColor: "bg-orange-500/15",
    textColor: "text-orange-300",
  },
  UNSPECIFIED: {
    label: "Needs Review",
    icon: <HelpCircle className="h-3.5 w-3.5" />,
    bgColor: "bg-slate-500/15",
    textColor: "text-slate-300",
  },
};

export function GateChip({ reason, costAmount, className }: GateChipProps) {
  const config = GATE_CONFIG[reason] || GATE_CONFIG.UNSPECIFIED;

  // For fee quotes, show the amount if available
  const label =
    reason === "FEE_QUOTE" && costAmount
      ? `Fee $${costAmount.toLocaleString()}`
      : config.label;

  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1.5 font-medium px-2.5 py-1",
        config.bgColor,
        config.textColor,
        "border-0",
        className
      )}
    >
      {config.icon}
      <span>{label}</span>
    </Badge>
  );
}

// Gate type labels for filters — includes all pause reasons
export const GATE_TYPE_LABELS: Record<PauseReason, string> = {
  FEE_QUOTE: "Fee Quote",
  DENIAL: "Denial",
  SCOPE: "Scope Issue",
  ID_REQUIRED: "ID Required",
  SENSITIVE: "Sensitive",
  CLOSE_ACTION: "Close Action",
  proposal_pending: "Proposal Pending",
  execution_blocked: "Execution Blocked",
  email_send_failed: "Email Failed",
  portal_failed: "Portal Failed",
  portal_timed_out: "Portal Timeout",
  escalated: "Escalated",
  agent_run_failed: "Agent Error",
  stuck_portal_task: "Portal Stuck",
  portal_stuck: "Portal Stuck",
  UNSPECIFIED: "Needs Review",
};
