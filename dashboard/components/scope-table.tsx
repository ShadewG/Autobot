"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScopeItem } from "@/lib/types";
import { CheckCircle, XCircle, HelpCircle, FileX, Ban } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<ScopeItem['status'], {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bgColor: string;
  label: string;
}> = {
  REQUESTED: {
    icon: HelpCircle,
    color: "text-gray-500",
    bgColor: "bg-gray-50",
    label: "Unknown"
  },
  CONFIRMED_AVAILABLE: {
    icon: CheckCircle,
    color: "text-green-600",
    bgColor: "bg-green-50",
    label: "Available"
  },
  NOT_DISCLOSABLE: {
    icon: Ban,
    color: "text-red-600",
    bgColor: "bg-red-50",
    label: "Exempt"
  },
  NOT_HELD: {
    icon: FileX,
    color: "text-orange-600",
    bgColor: "bg-orange-50",
    label: "Not Held"
  },
  PENDING: {
    icon: HelpCircle,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
    label: "Pending"
  },
};

interface ScopeTableProps {
  items: ScopeItem[];
  className?: string;
}

export function ScopeTable({ items, className }: ScopeTableProps) {
  if (!items || items.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        No scope items defined
      </div>
    );
  }

  return (
    <div className={cn("border rounded-lg overflow-hidden", className)}>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50">
            <TableHead className="text-xs font-semibold">Item</TableHead>
            <TableHead className="text-xs font-semibold w-[120px]">Status</TableHead>
            <TableHead className="text-xs font-semibold">Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item, index) => {
            const config = STATUS_CONFIG[item.status];
            const Icon = config.icon;

            return (
              <TableRow key={index} className={cn("text-sm", config.bgColor)}>
                <TableCell className="font-medium py-2">
                  {item.name}
                </TableCell>
                <TableCell className="py-2">
                  <div className={cn("flex items-center gap-1.5", config.color)}>
                    <Icon className="h-4 w-4" />
                    <span className="text-xs font-medium">{config.label}</span>
                  </div>
                </TableCell>
                <TableCell className="py-2">
                  {item.reason ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground cursor-help truncate max-w-[200px] block">
                          {item.reason.length > 40
                            ? `${item.reason.substring(0, 40)}...`
                            : item.reason}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-[300px]">
                        <p className="text-xs">{item.reason}</p>
                        {item.confidence !== undefined && item.confidence < 1 && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Confidence: {Math.round(item.confidence * 100)}%
                          </p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {item.status === 'REQUESTED' ? 'No mention' : '—'}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// Summary badge counts for quick overview
interface ScopeSummaryProps {
  items: ScopeItem[];
}

export function ScopeSummary({ items }: ScopeSummaryProps) {
  if (!items || items.length === 0) return null;

  const counts = {
    available: items.filter(i => i.status === 'CONFIRMED_AVAILABLE').length,
    exempt: items.filter(i => i.status === 'NOT_DISCLOSABLE').length,
    notHeld: items.filter(i => i.status === 'NOT_HELD').length,
    unknown: items.filter(i => i.status === 'REQUESTED' || i.status === 'PENDING').length,
  };

  return (
    <div className="flex items-center gap-3 text-xs">
      {counts.available > 0 && (
        <span className="flex items-center gap-1 text-green-600">
          <CheckCircle className="h-3 w-3" />
          {counts.available} available
        </span>
      )}
      {counts.exempt > 0 && (
        <span className="flex items-center gap-1 text-red-600">
          <Ban className="h-3 w-3" />
          {counts.exempt} exempt
        </span>
      )}
      {counts.notHeld > 0 && (
        <span className="flex items-center gap-1 text-orange-600">
          <FileX className="h-3 w-3" />
          {counts.notHeld} not held
        </span>
      )}
      {counts.unknown > 0 && (
        <span className="flex items-center gap-1 text-gray-500">
          <HelpCircle className="h-3 w-3" />
          {counts.unknown} unknown
        </span>
      )}
    </div>
  );
}
