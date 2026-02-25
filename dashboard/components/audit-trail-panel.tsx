"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { formatDate, cn } from "@/lib/utils";
import {
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  User,
  Send,
  ChevronRight,
  Shield,
  Zap,
  Bot,
  AlertTriangle,
  Key,
} from "lucide-react";

interface AuditEntry {
  id: string;
  type: 'proposal_created' | 'proposal_approved' | 'proposal_dismissed' | 'proposal_adjusted' | 'action_executed' | 'action_dry_run' | 'run_started' | 'run_completed' | 'run_failed';
  timestamp: string;
  actor?: string; // who performed the action
  details: {
    proposal_id?: number;
    run_id?: number;
    action_type?: string;
    execution_key?: string;
    execution_mode?: 'DRY' | 'LIVE';
    sent_at?: string;
    failure_reason?: string;
    confidence?: number;
  };
}

interface AuditTrailPanelProps {
  entries: AuditEntry[];
  executionMode?: 'DRY' | 'LIVE';
}

const ENTRY_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  proposal_created: {
    icon: <Bot className="h-3.5 w-3.5" />,
    color: "text-blue-400 bg-blue-500/10",
    label: "Proposal Created",
  },
  proposal_approved: {
    icon: <CheckCircle className="h-3.5 w-3.5" />,
    color: "text-green-400 bg-green-500/10",
    label: "Approved",
  },
  proposal_dismissed: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    color: "text-muted-foreground bg-muted",
    label: "Dismissed",
  },
  proposal_adjusted: {
    icon: <FileText className="h-3.5 w-3.5" />,
    color: "text-purple-400 bg-purple-500/10",
    label: "Adjusted",
  },
  action_executed: {
    icon: <Zap className="h-3.5 w-3.5" />,
    color: "text-green-400 bg-green-500/10",
    label: "Executed (LIVE)",
  },
  action_dry_run: {
    icon: <Shield className="h-3.5 w-3.5" />,
    color: "text-blue-400 bg-blue-500/10",
    label: "Executed (DRY)",
  },
  run_started: {
    icon: <Clock className="h-3.5 w-3.5" />,
    color: "text-blue-400 bg-blue-500/10",
    label: "Run Started",
  },
  run_completed: {
    icon: <CheckCircle className="h-3.5 w-3.5" />,
    color: "text-green-400 bg-green-500/10",
    label: "Run Completed",
  },
  run_failed: {
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
    color: "text-red-400 bg-red-500/10",
    label: "Run Failed",
  },
};

export function AuditTrailPanel({ entries, executionMode }: AuditTrailPanelProps) {
  if (!entries || entries.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Audit Trail
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            No audit entries yet
          </p>
        </CardContent>
      </Card>
    );
  }

  // Group entries by date
  const groupedEntries = entries.reduce((groups, entry) => {
    const date = new Date(entry.timestamp).toLocaleDateString();
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(entry);
    return groups;
  }, {} as Record<string, AuditEntry[]>);

  // Count stats
  const proposalsCreated = entries.filter(e => e.type === 'proposal_created').length;
  const proposalsApproved = entries.filter(e => e.type === 'proposal_approved').length;
  const actionsExecuted = entries.filter(e => e.type === 'action_executed' || e.type === 'action_dry_run').length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Audit Trail
          </CardTitle>
          {executionMode && (
            <Badge
              variant="outline"
              className={cn(
                "text-xs",
                executionMode === "LIVE"
                  ? "border-red-700/50 text-red-400"
                  : "border-blue-700/50 text-blue-400"
              )}
            >
              {executionMode === "LIVE" ? (
                <Zap className="h-3 w-3 mr-1" />
              ) : (
                <Shield className="h-3 w-3 mr-1" />
              )}
              {executionMode}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-muted/50 rounded p-2 text-center">
            <p className="text-lg font-bold">{proposalsCreated}</p>
            <p className="text-[10px] text-muted-foreground">Proposals</p>
          </div>
          <div className="bg-muted/50 rounded p-2 text-center">
            <p className="text-lg font-bold">{proposalsApproved}</p>
            <p className="text-[10px] text-muted-foreground">Approved</p>
          </div>
          <div className="bg-muted/50 rounded p-2 text-center">
            <p className="text-lg font-bold">{actionsExecuted}</p>
            <p className="text-[10px] text-muted-foreground">Executed</p>
          </div>
        </div>

        <Separator />

        {/* Timeline */}
        <ScrollArea className="h-[300px]">
          <div className="space-y-4">
            {Object.entries(groupedEntries).map(([date, dayEntries]) => (
              <div key={date}>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  {date}
                </p>
                <div className="space-y-2">
                  {dayEntries.map((entry) => {
                    const config = ENTRY_CONFIG[entry.type] || ENTRY_CONFIG.proposal_created;
                    return (
                      <Collapsible key={entry.id}>
                        <CollapsibleTrigger className="w-full">
                          <div className="flex items-center gap-2 text-left p-2 rounded hover:bg-muted/50 transition-colors">
                            <div className={cn("p-1.5 rounded", config.color)}>
                              {config.icon}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium">{config.label}</p>
                                {entry.details.action_type && (
                                  <Badge variant="outline" className="text-[10px]">
                                    {entry.details.action_type}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {new Date(entry.timestamp).toLocaleTimeString()}
                                {entry.actor && ` • ${entry.actor}`}
                              </p>
                            </div>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="ml-9 pl-2 border-l-2 border-muted py-2 space-y-1">
                            {entry.details.proposal_id && (
                              <p className="text-xs">
                                <span className="text-muted-foreground">Proposal:</span>{" "}
                                #{entry.details.proposal_id}
                              </p>
                            )}
                            {entry.details.run_id && (
                              <p className="text-xs">
                                <span className="text-muted-foreground">Run:</span>{" "}
                                #{entry.details.run_id}
                              </p>
                            )}
                            {entry.details.execution_key && (
                              <p className="text-xs flex items-center gap-1">
                                <Key className="h-3 w-3 text-muted-foreground" />
                                <span className="font-mono text-[10px]">
                                  {entry.details.execution_key}
                                </span>
                              </p>
                            )}
                            {entry.details.execution_mode && (
                              <p className="text-xs">
                                <span className="text-muted-foreground">Mode:</span>{" "}
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "text-[10px]",
                                    entry.details.execution_mode === "LIVE"
                                      ? "border-red-700/50 text-red-400"
                                      : "border-blue-700/50 text-blue-400"
                                  )}
                                >
                                  {entry.details.execution_mode}
                                </Badge>
                              </p>
                            )}
                            {entry.details.sent_at && (
                              <p className="text-xs">
                                <span className="text-muted-foreground">Sent:</span>{" "}
                                {formatDate(entry.details.sent_at)}
                              </p>
                            )}
                            {entry.details.failure_reason && (
                              <p className="text-xs text-red-400">
                                <span className="text-muted-foreground">Error:</span>{" "}
                                {entry.details.failure_reason}
                              </p>
                            )}
                            {entry.details.confidence !== undefined && (
                              <p className="text-xs">
                                <span className="text-muted-foreground">Confidence:</span>{" "}
                                {Math.round(entry.details.confidence * 100)}%
                              </p>
                            )}
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
