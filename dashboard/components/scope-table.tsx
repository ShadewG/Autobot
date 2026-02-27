"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScopeItem } from "@/lib/types";
import { CheckCircle, XCircle, HelpCircle, FileX, Ban, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatusConfig {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bgColor: string;
  label: string;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  REQUESTED: {
    icon: HelpCircle,
    color: "text-gray-500",
    bgColor: "bg-muted",
    label: "Requested"
  },
  CONFIRMED_AVAILABLE: {
    icon: CheckCircle,
    color: "text-green-400",
    bgColor: "bg-green-500/10",
    label: "Available"
  },
  NOT_DISCLOSABLE: {
    icon: Ban,
    color: "text-red-400",
    bgColor: "bg-red-500/10",
    label: "Exempt"
  },
  NOT_HELD: {
    icon: FileX,
    color: "text-orange-400",
    bgColor: "bg-orange-500/10",
    label: "Not Held"
  },
  PENDING: {
    icon: HelpCircle,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    label: "Pending"
  },
  DELIVERED: {
    icon: CheckCircle,
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    label: "Delivered"
  },
  DENIED: {
    icon: XCircle,
    color: "text-red-400",
    bgColor: "bg-red-500/10",
    label: "Denied"
  },
  PARTIAL: {
    icon: HelpCircle,
    color: "text-yellow-400",
    bgColor: "bg-yellow-500/10",
    label: "Partial"
  },
  EXEMPT: {
    icon: Ban,
    color: "text-red-400",
    bgColor: "bg-red-500/10",
    label: "Exempt"
  },
};

const FALLBACK_CONFIG: StatusConfig = {
  icon: HelpCircle,
  color: "text-gray-500",
  bgColor: "bg-muted",
  label: "Unknown"
};

interface ScopeTableProps {
  items: ScopeItem[];
  className?: string;
  onStatusChange?: (itemIndex: number, newStatus: ScopeItem['status'], reason?: string) => void;
  isUpdating?: boolean;
}

const SETTABLE_STATUSES: Array<{ status: ScopeItem['status']; label: string }> = [
  { status: 'CONFIRMED_AVAILABLE', label: 'Mark as Available' },
  { status: 'NOT_DISCLOSABLE', label: 'Mark as Exempt' },
  { status: 'NOT_HELD', label: 'Mark as Not Held' },
];

export function ScopeTable({ items, className, onStatusChange, isUpdating }: ScopeTableProps) {
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
            const config = STATUS_CONFIG[item.status] || FALLBACK_CONFIG;
            const Icon = config.icon;
            const isUnknown = item.status === 'REQUESTED' || item.status === 'PENDING';
            const canEdit = isUnknown && onStatusChange;

            return (
              <TableRow key={index} className={cn("text-sm", config.bgColor)}>
                <TableCell className="font-medium py-2">
                  {item.name}
                </TableCell>
                <TableCell className="py-2">
                  {canEdit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded hover:bg-muted/50 transition-colors cursor-pointer",
                          config.color,
                          isUpdating && "opacity-50 pointer-events-none"
                        )}
                        disabled={isUpdating}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="text-xs font-medium">{config.label}</span>
                        <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {SETTABLE_STATUSES.map((s) => {
                          const statusConfig = STATUS_CONFIG[s.status];
                          const StatusIcon = statusConfig.icon;
                          return (
                            <DropdownMenuItem
                              key={s.status}
                              onClick={() => onStatusChange(index, s.status)}
                              className={cn("flex items-center gap-2", statusConfig.color)}
                            >
                              <StatusIcon className="h-4 w-4" />
                              <span>{s.label}</span>
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <div className={cn("flex items-center gap-1.5", config.color)}>
                      <Icon className="h-4 w-4" />
                      <span className="text-xs font-medium">{config.label}</span>
                    </div>
                  )}
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
                      {isUnknown && canEdit ? (
                        <span className="italic">Click status to set</span>
                      ) : isUnknown ? (
                        'No mention'
                      ) : (
                        '—'
                      )}
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
        <span className="flex items-center gap-1 text-green-400">
          <CheckCircle className="h-3 w-3" />
          {counts.available} available
        </span>
      )}
      {counts.exempt > 0 && (
        <span className="flex items-center gap-1 text-red-400">
          <Ban className="h-3 w-3" />
          {counts.exempt} exempt
        </span>
      )}
      {counts.notHeld > 0 && (
        <span className="flex items-center gap-1 text-orange-400">
          <FileX className="h-3 w-3" />
          {counts.notHeld} not held
        </span>
      )}
      {counts.unknown > 0 && (
        <span className="flex items-center gap-1 text-gray-500">
          <HelpCircle className="h-3 w-3" />
          {counts.unknown} unclassified
        </span>
      )}
    </div>
  );
}
