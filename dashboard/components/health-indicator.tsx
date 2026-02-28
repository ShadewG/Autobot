"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ControlMismatch } from "@/lib/types";

interface HealthIndicatorProps {
  mismatches: ControlMismatch[] | undefined;
  onRepair?: () => void;
}

export function HealthIndicator({ mismatches, onRepair }: HealthIndicatorProps) {
  if (!mismatches || mismatches.length === 0) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <AlertTriangle className="h-3.5 w-3.5 text-orange-400" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[280px]">
          <div className="space-y-1.5">
            {mismatches.map((m, i) => (
              <p key={i} className="text-xs">
                {m.message}
              </p>
            ))}
            {onRepair && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs mt-1"
                onClick={(e) => {
                  e.stopPropagation();
                  onRepair();
                }}
              >
                Fix
              </Button>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
