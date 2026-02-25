"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScopeItem } from "@/lib/types";
import { CheckCircle, XCircle, HelpCircle, FileX, Ban } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<ScopeItem['status'], {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  label: string;
}> = {
  REQUESTED: { icon: HelpCircle, color: "text-gray-500", label: "Requested" },
  CONFIRMED_AVAILABLE: { icon: CheckCircle, color: "text-green-400", label: "Available" },
  NOT_DISCLOSABLE: { icon: Ban, color: "text-red-400", label: "Not Disclosable" },
  NOT_HELD: { icon: FileX, color: "text-orange-400", label: "Not Held" },
  PENDING: { icon: HelpCircle, color: "text-blue-400", label: "Pending" },
};

interface ScopeBreakdownProps {
  items: ScopeItem[];
  className?: string;
}

export function ScopeBreakdown({ items, className }: ScopeBreakdownProps) {
  if (!items || items.length === 0) {
    return null;
  }

  // Group items by status
  const requested = items.filter(i => i.status === 'REQUESTED');
  const available = items.filter(i => i.status === 'CONFIRMED_AVAILABLE');
  const notDisclosable = items.filter(i => i.status === 'NOT_DISCLOSABLE');
  const notHeld = items.filter(i => i.status === 'NOT_HELD');
  const pending = items.filter(i => i.status === 'PENDING');

  const renderGroup = (
    groupItems: ScopeItem[],
    title: string,
    icon: React.ComponentType<{ className?: string }>,
    color: string
  ) => {
    if (groupItems.length === 0) return null;
    const Icon = icon;

    return (
      <div className="space-y-1">
        <div className={cn("flex items-center gap-1 text-xs font-medium", color)}>
          <Icon className="h-3 w-3" />
          {title}
        </div>
        <div className="flex flex-wrap gap-1">
          {groupItems.map((item, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[10px] cursor-help",
                    item.status === 'NOT_DISCLOSABLE' && "border-red-700/50 bg-red-500/10 text-red-300",
                    item.status === 'NOT_HELD' && "border-orange-700/50 bg-orange-500/10 text-orange-300",
                    item.status === 'CONFIRMED_AVAILABLE' && "border-green-700/50 bg-green-500/10 text-green-300",
                  )}
                >
                  {item.name}
                </Badge>
              </TooltipTrigger>
              {item.reason && (
                <TooltipContent>
                  <p className="text-xs">{item.reason}</p>
                  {item.confidence && item.confidence < 1 && (
                    <p className="text-xs text-muted-foreground">
                      Confidence: {Math.round(item.confidence * 100)}%
                    </p>
                  )}
                </TooltipContent>
              )}
            </Tooltip>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* Original request */}
      {requested.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Originally Requested</p>
          <div className="flex flex-wrap gap-1">
            {requested.map((item, i) => (
              <Badge key={i} variant="outline" className="text-[10px]">
                {item.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Not disclosable */}
      {renderGroup(
        notDisclosable,
        "Confirmed Not Disclosable",
        Ban,
        "text-red-400"
      )}

      {/* Not held */}
      {renderGroup(
        notHeld,
        "Confirmed Not Held",
        FileX,
        "text-orange-400"
      )}

      {/* Available */}
      {renderGroup(
        available,
        "Confirmed Available",
        CheckCircle,
        "text-green-400"
      )}

      {/* Pending */}
      {renderGroup(
        pending,
        "Still Pending",
        HelpCircle,
        "text-blue-400"
      )}
    </div>
  );
}
