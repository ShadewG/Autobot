"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Constraint } from "@/lib/types";
import { AlertTriangle, Ban, FileX, DollarSign, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

const CONSTRAINT_CONFIG: Record<string, {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bgColor: string;
}> = {
  EXEMPTION: { icon: Ban, color: "text-red-400", bgColor: "bg-red-500/10" },
  NOT_HELD: { icon: FileX, color: "text-orange-400", bgColor: "bg-orange-500/10" },
  REDACTION_REQUIRED: { icon: Shield, color: "text-yellow-400", bgColor: "bg-yellow-500/10" },
  FEE_REQUIRED: { icon: DollarSign, color: "text-blue-400", bgColor: "bg-blue-500/10" },
  // Additional types the AI can assign
  BWC_EXEMPT: { icon: Ban, color: "text-red-400", bgColor: "bg-red-500/10" },
  ID_REQUIRED: { icon: Shield, color: "text-blue-400", bgColor: "bg-blue-500/10" },
  INVESTIGATION_ACTIVE: { icon: AlertTriangle, color: "text-yellow-400", bgColor: "bg-yellow-500/10" },
  RECORDS_NOT_HELD: { icon: FileX, color: "text-orange-400", bgColor: "bg-orange-500/10" },
  PARTIAL_DENIAL: { icon: Ban, color: "text-orange-400", bgColor: "bg-orange-500/10" },
  DENIAL_RECEIVED: { icon: Ban, color: "text-red-400", bgColor: "bg-red-500/10" },
};

const FALLBACK_CONSTRAINT_CONFIG = {
  icon: AlertTriangle,
  color: "text-muted-foreground",
  bgColor: "bg-muted",
};

interface ConstraintsDisplayProps {
  constraints: Constraint[];
  compact?: boolean;
  className?: string;
}

export function ConstraintsDisplay({ constraints, compact = false, className }: ConstraintsDisplayProps) {
  if (!constraints || constraints.length === 0) {
    return null;
  }

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1 flex-wrap", className)}>
        <AlertTriangle className="h-3 w-3 text-yellow-400" />
        <span className="text-xs text-muted-foreground">
          {constraints.length} constraint{constraints.length !== 1 ? 's' : ''} detected
        </span>
        {constraints.slice(0, 2).map((c, i) => {
          const config = CONSTRAINT_CONFIG[c.type] || FALLBACK_CONSTRAINT_CONFIG;
          const Icon = config.icon;
          return (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <Badge variant="outline" className={cn("text-[10px] gap-0.5", config.color)}>
                  <Icon className="h-2.5 w-2.5" />
                  {c.affected_items[0]}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">{c.description}</p>
                <p className="text-xs">{c.source}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
        {constraints.length > 2 && (
          <span className="text-xs text-muted-foreground">+{constraints.length - 2} more</span>
        )}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4 text-yellow-400" />
        Constraints Detected
      </div>
      <div className="space-y-2">
        {constraints.map((constraint, index) => {
          const config = CONSTRAINT_CONFIG[constraint.type] || FALLBACK_CONSTRAINT_CONFIG;
          const Icon = config.icon;

          return (
            <div
              key={index}
              className={cn(
                "rounded-lg p-3 border",
                config.bgColor
              )}
            >
              <div className="flex items-start gap-2">
                <Icon className={cn("h-4 w-4 mt-0.5 flex-shrink-0", config.color)} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{constraint.description}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{constraint.source}</p>
                  {constraint.affected_items.length > 0 && (
                    <div className="flex items-center gap-1 mt-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Affects:</span>
                      {constraint.affected_items.map((item, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {item}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {constraint.confidence < 0.9 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Confidence: {Math.round(constraint.confidence * 100)}%
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
