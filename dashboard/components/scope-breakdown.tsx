"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScopeItem } from "@/lib/types";
import { CheckCircle, XCircle, HelpCircle, FileX, Ban } from "lucide-react";
import { cn } from "@/lib/utils";

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
  const delivered = items.filter(i => i.status === 'DELIVERED');
  const notDisclosable = items.filter(i => i.status === 'NOT_DISCLOSABLE' || i.status === 'EXEMPT');
  const denied = items.filter(i => i.status === 'DENIED');
  const notHeld = items.filter(i => i.status === 'NOT_HELD');
  const partial = items.filter(i => i.status === 'PARTIAL');
  const pending = items.filter(i => i.status === 'PENDING');

  const renderGroup = (
    groupItems: ScopeItem[],
    title: string,
    icon: React.ComponentType<{ className?: string }>,
    color: string,
    badgeClass?: string
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
                  className={cn("text-[10px] cursor-help", badgeClass)}
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

      {renderGroup(delivered, "Delivered", CheckCircle, "text-emerald-400", "border-emerald-700/50 bg-emerald-500/10 text-emerald-300")}
      {renderGroup(notDisclosable, "Not Disclosable / Exempt", Ban, "text-red-400", "border-red-700/50 bg-red-500/10 text-red-300")}
      {renderGroup(denied, "Denied", XCircle, "text-red-400", "border-red-700/50 bg-red-500/10 text-red-300")}
      {renderGroup(notHeld, "Not Held", FileX, "text-orange-400", "border-orange-700/50 bg-orange-500/10 text-orange-300")}
      {renderGroup(partial, "Partial", HelpCircle, "text-yellow-400", "border-yellow-700/50 bg-yellow-500/10 text-yellow-300")}
      {renderGroup(available, "Confirmed Available", CheckCircle, "text-green-400", "border-green-700/50 bg-green-500/10 text-green-300")}
      {renderGroup(pending, "Still Pending", HelpCircle, "text-blue-400")}
    </div>
  );
}
