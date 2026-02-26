"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetcher, requestsAPI, type AgentRun, type AgentRunDiff } from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import {
  Search,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Play,
  RefreshCw,
  ChevronRight,
  Bot,
  Terminal,
  Database,
  ExternalLink,
} from "lucide-react";

const TRIGGER_PROJECT_URL = "https://cloud.trigger.dev/projects/v3/proj_afwkrlynxcczbgflspqf";

function triggerRunUrl(triggerRunId: string): string {
  return `${TRIGGER_PROJECT_URL}/runs/${triggerRunId}`;
}

const STATUS_CONFIG: Record<AgentRun['status'], {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  label: string;
}> = {
  running: {
    icon: Loader2,
    color: "text-blue-400 bg-blue-500/10",
    label: "Running",
  },
  completed: {
    icon: CheckCircle,
    color: "text-green-400 bg-green-500/10",
    label: "Completed",
  },
  failed: {
    icon: XCircle,
    color: "text-red-400 bg-red-500/10",
    label: "Failed",
  },
  gated: {
    icon: AlertTriangle,
    color: "text-amber-400 bg-amber-500/10",
    label: "Gated",
  },
};

interface RunsResponse {
  runs: Array<AgentRun & { case_name?: string }>;
}

export default function RunsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRun, setSelectedRun] = useState<(AgentRun & { case_name?: string }) | null>(null);
  const [runDiff, setRunDiff] = useState<AgentRunDiff | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);

  // Fetch all recent runs across all cases
  const { data, error, isLoading, mutate } = useSWR<RunsResponse>(
    "/runs",
    fetcher,
    { refreshInterval: 10000 }
  );

  const handleViewRun = async (run: AgentRun & { case_name?: string }) => {
    setSelectedRun(run);
    setIsLoadingDiff(true);
    setRunDiff(null);

    try {
      const diff = await requestsAPI.getAgentRunDiff(run.case_id, run.id);
      setRunDiff(diff);
    } catch (error) {
      console.error("Failed to load run details:", error);
    } finally {
      setIsLoadingDiff(false);
    }
  };

  const handleReplay = async (run: AgentRun) => {
    try {
      await requestsAPI.replayAgentRun(run.case_id, run.id);
      mutate();
    } catch (error) {
      console.error("Failed to replay run:", error);
    }
  };

  // Get runs from response
  const allRunsList = data?.runs || [];

  // Filter runs
  const filteredRuns = allRunsList.filter((run) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      String(run.id).toLowerCase().includes(query) ||
      String(run.case_id).toLowerCase().includes(query) ||
      run.case_name?.toLowerCase().includes(query) ||
      run.status?.toLowerCase().includes(query) ||
      run.trigger_type?.toLowerCase().includes(query)
    );
  });

  // Sort by started_at descending
  const sortedRuns = [...filteredRuns].sort((a, b) =>
    new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load runs</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="h-6 w-6" />
            Agent Runs
          </h1>
          <p className="text-sm text-muted-foreground">
            Monitor agent executions, errors, and debug issues
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search runs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        {(['running', 'completed', 'failed', 'gated'] as const).map((status) => {
          const count = allRunsList.filter((r) => r.status === status).length;
          const config = STATUS_CONFIG[status];
          const Icon = config.icon;
          return (
            <Card key={status}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{config.label}</p>
                    <p className="text-2xl font-bold">{count}</p>
                  </div>
                  <div className={cn("p-2 rounded-full", config.color)}>
                    <Icon className={cn("h-5 w-5", status === 'running' && "animate-spin")} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Runs Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : sortedRuns.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No agent runs found
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Case</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRuns.map((run) => {
                  const config = STATUS_CONFIG[run.status];
                  const Icon = config.icon;
                  const duration = run.completed_at
                    ? Math.round(
                        (new Date(run.completed_at).getTime() -
                          new Date(run.started_at).getTime()) /
                          1000
                      )
                    : null;

                  return (
                    <TableRow
                      key={run.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleViewRun(run)}
                    >
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn("gap-1", config.color)}
                        >
                          <Icon className={cn("h-3 w-3", run.status === 'running' && "animate-spin")} />
                          {config.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/requests/detail?id=${run.case_id}`}
                          className="hover:underline text-primary"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {run.case_name || run.case_id.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {run.trigger_type || "unknown"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(run.started_at)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {duration !== null ? `${duration}s` : "—"}
                      </TableCell>
                      <TableCell>
                        {run.error_message ? (
                          <span className="text-xs text-red-400 truncate max-w-[200px] block">
                            {run.error_message}
                          </span>
                        ) : run.final_action ? (
                          <Badge variant="secondary" className="text-xs">
                            {run.final_action}
                          </Badge>
                        ) : run.gated_reason ? (
                          <span className="text-xs text-amber-400">
                            Gated: {run.gated_reason}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {run.trigger_run_id && (
                            <a
                              href={triggerRunUrl(run.trigger_run_id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              title="View in Trigger.dev"
                            >
                              <Button variant="ghost" size="sm">
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                            </a>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleViewRun(run);
                            }}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                          {run.status === 'failed' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReplay(run);
                              }}
                            >
                              <Play className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Run Details Dialog */}
      <Dialog open={!!selectedRun} onOpenChange={(open) => !open && setSelectedRun(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Run Details
              {selectedRun && (
                <Badge
                  variant="outline"
                  className={cn("ml-2", STATUS_CONFIG[selectedRun.status].color)}
                >
                  {STATUS_CONFIG[selectedRun.status].label}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {isLoadingDiff ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : selectedRun ? (
            <Tabs defaultValue="overview" className="mt-4">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {runDiff?.logs && runDiff.logs.length > 0 && (
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                )}
                {(runDiff?.state_before || runDiff?.state_after) && (
                  <TabsTrigger value="state">State Diff</TabsTrigger>
                )}
                {runDiff?.snapshots && runDiff.snapshots.length > 0 && (
                  <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="overview" className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Run ID</p>
                    <p className="font-mono text-sm">{selectedRun.id}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Case ID</p>
                    <Link
                      href={`/requests/detail?id=${selectedRun.case_id}`}
                      className="text-primary hover:underline"
                    >
                      {selectedRun.case_id}
                    </Link>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Trigger</p>
                    <p>{selectedRun.trigger_type}</p>
                  </div>
                  {selectedRun.trigger_run_id && (
                    <div>
                      <p className="text-sm text-muted-foreground">Trigger.dev Run</p>
                      <a
                        href={triggerRunUrl(selectedRun.trigger_run_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline flex items-center gap-1 text-sm"
                      >
                        View in Trigger.dev
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                  <div>
                    <p className="text-sm text-muted-foreground">Started</p>
                    <p>{formatDate(selectedRun.started_at)}</p>
                  </div>
                  {selectedRun.completed_at && (
                    <div>
                      <p className="text-sm text-muted-foreground">Completed</p>
                      <p>{formatDate(selectedRun.completed_at)}</p>
                    </div>
                  )}
                  {selectedRun.final_action && (
                    <div>
                      <p className="text-sm text-muted-foreground">Final Action</p>
                      <Badge variant="secondary">{selectedRun.final_action}</Badge>
                    </div>
                  )}
                </div>

                {selectedRun.error_message && (
                  <div className="bg-red-950/30 border border-red-800 p-4">
                    <p className="text-sm font-medium text-red-400 mb-1">Error</p>
                    <pre className="text-sm text-red-300 whitespace-pre-wrap">
                      {selectedRun.error_message}
                    </pre>
                  </div>
                )}

                {selectedRun.node_trace && selectedRun.node_trace.length > 0 && (
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Node Trace</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {selectedRun.node_trace.map((node, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <Badge variant="outline" className="font-mono text-xs">
                            {node}
                          </Badge>
                          {i < selectedRun.node_trace!.length - 1 && (
                            <ChevronRight className="h-3 w-3 text-muted-foreground" />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="logs" className="mt-4">
                <ScrollArea className="h-[400px] border rounded-md">
                  <div className="p-4 font-mono text-sm">
                    {runDiff?.logs && runDiff.logs.length > 0 ? (
                      runDiff.logs.map((log, i) => (
                        <div key={i} className="py-1 border-b border-muted last:border-0">
                          {log}
                        </div>
                      ))
                    ) : selectedRun?.trigger_run_id ? (
                      <div className="text-center py-8 space-y-2">
                        <p className="text-muted-foreground">Logs are available in the Trigger.dev console</p>
                        <a href={triggerRunUrl(selectedRun.trigger_run_id)} target="_blank" rel="noopener noreferrer"
                          className="text-primary hover:underline flex items-center justify-center gap-1 text-sm">
                          View Logs <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">No logs available</p>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="state" className="mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium mb-2 flex items-center gap-1">
                      <Database className="h-4 w-4" />
                      State Before
                    </p>
                    <ScrollArea className="h-[350px] border rounded-md">
                      <pre className="p-4 text-xs">
                        {runDiff?.state_before
                          ? JSON.stringify(runDiff.state_before, null, 2)
                          : "No state data"}
                      </pre>
                    </ScrollArea>
                  </div>
                  <div>
                    <p className="text-sm font-medium mb-2 flex items-center gap-1">
                      <Database className="h-4 w-4" />
                      State After
                    </p>
                    <ScrollArea className="h-[350px] border rounded-md">
                      <pre className="p-4 text-xs">
                        {runDiff?.state_after
                          ? JSON.stringify(runDiff.state_after, null, 2)
                          : "No state data"}
                      </pre>
                    </ScrollArea>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="snapshots" className="mt-4">
                <ScrollArea className="h-[400px]">
                  {runDiff?.snapshots && runDiff.snapshots.length > 0 ? (
                    <div className="space-y-4">
                      {runDiff.snapshots.map((snapshot, i) => (
                        <Card key={i}>
                          <CardHeader className="py-2 px-4">
                            <div className="flex items-center justify-between">
                              <Badge variant="outline" className="font-mono">
                                {snapshot.node}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {formatDate(snapshot.timestamp)}
                              </span>
                            </div>
                          </CardHeader>
                          <CardContent className="py-2 px-4">
                            <pre className="text-xs overflow-auto max-h-[200px]">
                              {JSON.stringify(snapshot.state, null, 2)}
                            </pre>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center py-8 text-muted-foreground">
                      No snapshots available
                    </p>
                  )}
                </ScrollArea>
              </TabsContent>
            </Tabs>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
