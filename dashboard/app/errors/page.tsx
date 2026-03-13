"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { fetcher } from "@/lib/api";
import { formatRelativeTime, cn } from "@/lib/utils";
import {
  AlertTriangle,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Search,
  Server,
  Zap,
  CalendarClock,
  Activity,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface ErrorEvent {
  id: number;
  source_service: string;
  operation: string | null;
  case_id: number | null;
  proposal_id: number | null;
  message_id: number | null;
  run_id: number | null;
  error_name: string;
  error_code: string | null;
  error_message: string;
  stack: string | null;
  retryable: boolean | null;
  retry_attempt: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info";

const SEVERITY_STYLES: Record<Severity, { dot: string; row: string; badge: string; label: string }> = {
  critical: { dot: "bg-red-500", row: "border-l-2 border-l-red-500/60", badge: "bg-red-500/10 text-red-400", label: "Critical" },
  warning: { dot: "bg-amber-500", row: "border-l-2 border-l-amber-500/40", badge: "bg-amber-500/10 text-amber-400", label: "Warning" },
  info: { dot: "bg-blue-500", row: "border-l-2 border-l-blue-500/20", badge: "bg-blue-500/10 text-blue-400", label: "Info" },
};

function classifySeverity(err: ErrorEvent): Severity {
  const msg = (err.error_message || "").toLowerCase();
  const name = (err.error_name || "").toLowerCase();
  const code = (err.error_code || "").toLowerCase();
  const service = err.source_service;

  // Critical: unrecoverable failures, data loss risk, decision engine errors
  if (service === "decision_engine") return "critical";
  if (name.includes("typeerror") || name.includes("referenceerror")) return "critical";
  if (code === "500" || code === "internal_server_error") return "critical";
  if (msg.includes("fatal") || msg.includes("corruption") || msg.includes("data loss")) return "critical";
  if (err.retryable === false && (err.retry_attempt ?? 0) >= 2) return "critical";
  if (msg.includes("cannot read propert") || msg.includes("undefined is not")) return "critical";

  // Warning: transient/retryable failures, rate limits, timeouts
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("econnreset")) return "warning";
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("quota")) return "warning";
  if (err.retryable === true) return "warning";
  if (msg.includes("agent run failed") || msg.includes("agent_run_failed")) return "warning";
  if (msg.includes("portal") && msg.includes("fail")) return "warning";

  // Info: everything else
  return "info";
}

const SERVICE_COLORS: Record<string, string> = {
  inbound_processor: "bg-blue-500/10 text-blue-400",
  email_executor: "bg-purple-500/10 text-purple-400",
  portal_agent: "bg-cyan-500/10 text-cyan-400",
  ai_service: "bg-amber-500/10 text-amber-400",
  trigger_task: "bg-green-500/10 text-green-400",
  decision_engine: "bg-red-500/10 text-red-400",
  eval_api: "bg-indigo-500/10 text-indigo-400",
  notion_service: "bg-orange-500/10 text-orange-400",
  dispatch: "bg-teal-500/10 text-teal-400",
  scheduler: "bg-violet-500/10 text-violet-400",
};

function serviceColor(service: string): string {
  return SERVICE_COLORS[service] || "bg-gray-500/10 text-gray-400";
}

function truncateMessage(msg: string, max = 120): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max) + "...";
}

function isToday(dateStr: string): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ErrorsPage() {
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [operationFilter, setOperationFilter] = useState<string>("");
  const [caseIdSearch, setCaseIdSearch] = useState<string>("");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  // Build query params from filters
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", "200");
    if (sourceFilter) params.set("sourceService", sourceFilter);
    if (operationFilter) params.set("operation", operationFilter);
    if (caseIdSearch) {
      const parsed = parseInt(caseIdSearch, 10);
      if (!isNaN(parsed) && parsed > 0) params.set("caseId", String(parsed));
    }
    return params.toString();
  }, [sourceFilter, operationFilter, caseIdSearch]);

  const {
    data,
    mutate,
    isLoading,
  } = useSWR<{ success: boolean; errors: ErrorEvent[] }>(
    `/eval/errors?${queryParams}`,
    fetcher,
    { refreshInterval: 30000 }
  );

  const allErrors = data?.errors || [];

  // Classify severity for each error
  const classifiedErrors = useMemo(
    () => allErrors.map((e) => ({ ...e, severity: classifySeverity(e) })),
    [allErrors]
  );

  // Apply severity filter
  const errors = useMemo(
    () => severityFilter ? classifiedErrors.filter((e) => e.severity === severityFilter) : classifiedErrors,
    [classifiedErrors, severityFilter]
  );

  // Compute KPIs (always from full set, not filtered)
  const kpis = useMemo(() => {
    const total = classifiedErrors.length;
    const todayCount = classifiedErrors.filter((e) => isToday(e.created_at)).length;

    const severityCounts = { critical: 0, warning: 0, info: 0 };
    const serviceCounts = new Map<string, number>();
    const operationCounts = new Map<string, number>();
    for (const e of classifiedErrors) {
      severityCounts[e.severity]++;
      serviceCounts.set(e.source_service, (serviceCounts.get(e.source_service) || 0) + 1);
      if (e.operation) {
        operationCounts.set(e.operation, (operationCounts.get(e.operation) || 0) + 1);
      }
    }

    let topService = "---";
    let topServiceCount = 0;
    for (const [svc, count] of serviceCounts) {
      if (count > topServiceCount) {
        topService = svc;
        topServiceCount = count;
      }
    }

    let topOperation = "---";
    let topOperationCount = 0;
    for (const [op, count] of operationCounts) {
      if (count > topOperationCount) {
        topOperation = op;
        topOperationCount = count;
      }
    }

    return { total, todayCount, topService, topServiceCount, topOperation, topOperationCount, severityCounts };
  }, [classifiedErrors]);

  // Unique filter options derived from full data (not filtered)
  const uniqueServices = useMemo(
    () => [...new Set(allErrors.map((e) => e.source_service))].sort(),
    [allErrors]
  );
  const uniqueOperations = useMemo(
    () => [...new Set(allErrors.map((e) => e.operation).filter(Boolean) as string[])].sort(),
    [allErrors]
  );

  const toggleRow = (id: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <AdminGuard>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="h-6 w-6" />
            Error Events
          </h1>
          <p className="text-sm text-muted-foreground">
            Tracked exceptions across all services. Auto-refreshes every 30s.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => mutate()}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Total Errors
            </p>
            <p className="text-2xl font-bold">{kpis.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" /> Errors Today
            </p>
            <p
              className={cn(
                "text-2xl font-bold",
                kpis.todayCount > 10
                  ? "text-red-400"
                  : kpis.todayCount > 0
                  ? "text-amber-400"
                  : "text-green-400"
              )}
            >
              {kpis.todayCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Server className="h-3.5 w-3.5" /> Top Service
            </p>
            <p className="text-lg font-bold truncate" title={kpis.topService}>
              {kpis.topService}
            </p>
            {kpis.topServiceCount > 0 && (
              <p className="text-xs text-muted-foreground">{kpis.topServiceCount} errors</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5" /> Top Operation
            </p>
            <p className="text-sm font-bold break-all" title={kpis.topOperation}>
              {kpis.topOperation}
            </p>
            {kpis.topOperationCount > 0 && (
              <p className="text-xs text-muted-foreground">{kpis.topOperationCount} errors</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Severity Summary Bar */}
      <div className="flex items-center gap-3">
        {(["critical", "warning", "info"] as Severity[]).map((sev) => {
          const style = SEVERITY_STYLES[sev];
          const count = kpis.severityCounts[sev];
          const isActive = severityFilter === sev;
          return (
            <button
              key={sev}
              onClick={() => setSeverityFilter(isActive ? "" : sev)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                isActive ? "border-foreground/30 bg-muted" : "border-transparent hover:bg-muted/50"
              )}
            >
              <span className={cn("h-2 w-2 rounded-full", style.dot)} />
              {style.label}
              <span className="font-mono">{count}</span>
            </button>
          );
        })}
        {severityFilter && (
          <button onClick={() => setSeverityFilter("")} className="text-[10px] text-muted-foreground hover:text-foreground ml-1">
            Clear
          </button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Source Service</label>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
              >
                <option value="">All services</option>
                {uniqueServices.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Operation</label>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={operationFilter}
                onChange={(e) => setOperationFilter(e.target.value)}
              >
                <option value="">All operations</option>
                {uniqueOperations.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Case ID</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by case ID..."
                  className="pl-8 h-9 w-[180px]"
                  value={caseIdSearch}
                  onChange={(e) => setCaseIdSearch(e.target.value)}
                />
              </div>
            </div>
            {(sourceFilter || operationFilter || caseIdSearch) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSourceFilter("");
                  setOperationFilter("");
                  setCaseIdSearch("");
                  setSeverityFilter("");
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Error Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Recent Errors
            <span className="text-xs text-muted-foreground font-normal ml-1">
              ({errors.length} shown)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : errors.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <AlertTriangle className="h-8 w-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No errors found.</p>
              <p className="text-xs mt-1">
                {sourceFilter || operationFilter || caseIdSearch
                  ? "Try adjusting your filters."
                  : "All systems running clean."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[800px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]" />
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Operation</TableHead>
                    <TableHead>Case</TableHead>
                    <TableHead>Error Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {errors.map((err) => {
                    const isExpanded = expandedRows.has(err.id);
                    const sevStyle = SEVERITY_STYLES[err.severity];
                    return (
                      <TableRow
                        key={err.id}
                        className={cn("cursor-pointer hover:bg-muted/50 align-top", sevStyle.row)}
                        onClick={() => toggleRow(err.id)}
                      >
                        <TableCell className="pr-0">
                          <div className="flex items-center gap-1.5">
                            <span className={cn("h-2 w-2 rounded-full shrink-0", sevStyle.dot)} title={sevStyle.label} />
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          <span title={new Date(err.created_at).toLocaleString()}>
                            {formatRelativeTime(err.created_at)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn("text-xs font-mono", serviceColor(err.source_service))}
                          >
                            {err.source_service}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {err.operation ? (
                            <span className="text-xs font-mono text-muted-foreground">
                              {err.operation}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">---</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {err.case_id ? (
                            <Link
                              href={`/requests/detail-v2?id=${err.case_id}`}
                              className="hover:underline text-primary text-xs"
                              onClick={(e) => e.stopPropagation()}
                            >
                              #{err.case_id}
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground">---</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div>
                            <p className="text-xs">
                              {isExpanded
                                ? err.error_message
                                : truncateMessage(err.error_message)}
                            </p>
                            {err.error_code && (
                              <Badge
                                variant="outline"
                                className="text-[10px] mt-1 bg-red-500/5 text-red-400"
                              >
                                {err.error_code}
                              </Badge>
                            )}
                            {isExpanded && (
                              <ExpandedErrorDetails error={err} />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
    </AdminGuard>
  );
}

// ── Expanded Details ─────────────────────────────────────────────────────────

function ExpandedErrorDetails({ error }: { error: ErrorEvent }) {
  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      {/* Metadata row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          <strong>Error:</strong> {error.error_name}
        </span>
        {error.error_code && (
          <span>
            <strong>Code:</strong> {error.error_code}
          </span>
        )}
        {error.retryable !== null && (
          <span>
            <strong>Retryable:</strong> {error.retryable ? "Yes" : "No"}
          </span>
        )}
        {error.retry_attempt !== null && (
          <span>
            <strong>Attempt:</strong> {error.retry_attempt}
          </span>
        )}
        {error.run_id && (
          <span>
            <strong>Run:</strong> {error.run_id}
          </span>
        )}
        {error.proposal_id && (
          <span>
            <strong>Proposal:</strong> {error.proposal_id}
          </span>
        )}
        {error.message_id && (
          <span>
            <strong>Message:</strong> {error.message_id}
          </span>
        )}
      </div>

      {/* Stack trace */}
      {error.stack && (
        <div>
          <p className="text-[11px] font-medium text-muted-foreground mb-1">Stack Trace</p>
          <pre className="text-[10px] leading-relaxed bg-muted/50 rounded-md p-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
            {error.stack}
          </pre>
        </div>
      )}

      {/* Metadata JSON */}
      {error.metadata && Object.keys(error.metadata).length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-muted-foreground mb-1">Metadata</p>
          <pre className="text-[10px] leading-relaxed bg-muted/50 rounded-md p-2 overflow-x-auto max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all">
            {JSON.stringify(error.metadata, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
