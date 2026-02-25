"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  CheckCircle,
  AlertTriangle,
  ShieldCheck,
  Clock,
  Ban,
  FileCheck,
  Mail,
} from "lucide-react";

interface SafetyHintsProps {
  // Message processing state
  lastInboundProcessed?: boolean;
  lastInboundProcessedAt?: string;

  // Proposal execution state
  proposalExecuted?: boolean;
  proposalExecutedAt?: string;

  // Duplicate prevention
  duplicateScheduledKeyPrevented?: boolean;

  // Active runs
  hasActiveRun?: boolean;

  // Mode indicators
  executionMode?: "DRY" | "LIVE";
  shadowMode?: boolean;

  className?: string;
}

export function SafetyHints({
  lastInboundProcessed,
  lastInboundProcessedAt,
  proposalExecuted,
  proposalExecutedAt,
  duplicateScheduledKeyPrevented,
  hasActiveRun,
  executionMode,
  shadowMode,
  className,
}: SafetyHintsProps) {
  const hints: Array<{
    icon: React.ReactNode;
    label: string;
    description: string;
    variant: "success" | "warning" | "info" | "neutral";
  }> = [];

  // Inbound message processed
  if (lastInboundProcessed) {
    hints.push({
      icon: <Mail className="h-3 w-3" />,
      label: "Inbound processed",
      description: lastInboundProcessedAt
        ? `Last inbound message processed at ${new Date(lastInboundProcessedAt).toLocaleString()}`
        : "Last inbound message has been processed",
      variant: "success",
    });
  }

  // Proposal already executed
  if (proposalExecuted) {
    hints.push({
      icon: <FileCheck className="h-3 w-3" />,
      label: "Proposal executed",
      description: proposalExecutedAt
        ? `Proposal executed at ${new Date(proposalExecutedAt).toLocaleString()}`
        : "Current proposal has been executed",
      variant: "success",
    });
  }

  // Duplicate prevention
  if (duplicateScheduledKeyPrevented) {
    hints.push({
      icon: <Ban className="h-3 w-3" />,
      label: "Duplicate prevented",
      description: "A duplicate run was prevented by scheduled_key check",
      variant: "warning",
    });
  }

  // Active run warning
  if (hasActiveRun) {
    hints.push({
      icon: <Clock className="h-3 w-3" />,
      label: "Run active",
      description: "An agent run is currently in progress",
      variant: "info",
    });
  }

  // Execution mode
  if (executionMode === "DRY") {
    hints.push({
      icon: <ShieldCheck className="h-3 w-3" />,
      label: "DRY mode",
      description: "No real actions will be executed",
      variant: "neutral",
    });
  }

  if (hints.length === 0) {
    return null;
  }

  const variantColors = {
    success: "bg-green-500/15 text-green-300 border-green-700/50",
    warning: "bg-amber-500/15 text-amber-300 border-amber-700/50",
    info: "bg-blue-500/15 text-blue-300 border-blue-700/50",
    neutral: "bg-muted text-muted-foreground border-border",
  };

  return (
    <TooltipProvider>
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {hints.map((hint, index) => (
          <Tooltip key={index}>
            <TooltipTrigger>
              <Badge
                variant="outline"
                className={cn(
                  "text-xs gap-1 cursor-help",
                  variantColors[hint.variant]
                )}
              >
                {hint.icon}
                {hint.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-sm">{hint.description}</p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

// Compact version for inline use
export function SafetyIndicator({
  type,
  tooltip,
  className,
}: {
  type: "processed" | "executed" | "duplicate-prevented" | "active-run" | "dry-mode";
  tooltip?: string;
  className?: string;
}) {
  const config = {
    processed: {
      icon: <CheckCircle className="h-3 w-3" />,
      color: "text-green-400",
      defaultTooltip: "Already processed",
    },
    executed: {
      icon: <FileCheck className="h-3 w-3" />,
      color: "text-green-400",
      defaultTooltip: "Already executed",
    },
    "duplicate-prevented": {
      icon: <Ban className="h-3 w-3" />,
      color: "text-amber-400",
      defaultTooltip: "Duplicate prevented",
    },
    "active-run": {
      icon: <Clock className="h-3 w-3" />,
      color: "text-blue-400",
      defaultTooltip: "Run in progress",
    },
    "dry-mode": {
      icon: <ShieldCheck className="h-3 w-3" />,
      color: "text-gray-500",
      defaultTooltip: "DRY mode active",
    },
  };

  const { icon, color, defaultTooltip } = config[type];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <span className={cn(color, className)}>{icon}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-sm">{tooltip || defaultTooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
