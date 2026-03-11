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
  Activity,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Search,
  AlertTriangle,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentLogEntry {
  id: string;
  timestamp: string;
  kind: string;
  source: string;
  title: string;
  summary: string | null;
  severity: string;
  run_id: number | null;
  message_id: number | null;
  proposal_id: number | null;
  case_id: number | null;
  step: string | null;
  payload: Record<string, unknown> | null;
}

interface AgentLogResponse {
  summary: {
    by_source: Record<string, number>;
    by_kind: Record<string, number>;
    by_severity: Record<string, number>;
  };
  next_before: string | null;
  entries: AgentLogEntry[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  case_event_ledger: "bg-blue-500/10 text-blue-400",
  activity_log: "bg-purple-500/10 text-purple-400",
  portal_submissions: "bg-cyan-500/10 text-cyan-400",
  email_events: "bg-amber-500/10 text-amber-400",
  error_events: "bg-red-500/10 text-red-400",
  decision_traces: "bg-green-500/10 text-green-400",
};

const KIND_COLORS: Record<string, string> = {
  state_transition: "bg-blue-500/10 text-blue-400",
  activity: "bg-purple-500/10 text-purple-400",
  agent_step: "bg-indigo-500/10 text-indigo-400",
  portal: "bg-cyan-500/10 text-cyan-400",
  provider_event: "bg-amber-500/10 text-amber-400",
  error: "bg-red-500/10 text-red-400",
  decision: "bg-green-500/10 text-green-400",
  execution: "bg-teal-500/10 text-teal-400",
  human_decision: "bg-orange-500/10 text-orange-400",
  proposal: "bg-violet-500/10 text-violet-400",
  message: "bg-pink-500/10 text-pink-400",
};

const SEVERITY_DOT: Record<string, string> = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
  debug: "bg-gray-500",
};

function severityDot(severity: string): string {
  return SEVERITY_DOT[severity] || "bg-gray-400";
}

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] || "bg-gray-500/10 text-gray-400";
}

function kindColor(kind: string): string {
  return KIND_COLORS[kind] || "bg-gray-500/10 text-gray-400";
}

function truncateTitle(title: string, max = 80): string {
  if (title.length <= max) return title;
  return title.slice(0, max) + "...";
}

const ALL_SOURCES = [
  "case_event_ledger",
  "activity_log",
  "portal_submissions",
  "email_events",
  "error_events",
  "decision_traces",
];

const ALL_KINDS = [
  "state_transition",
  "activity",
  "agent_step",
  "portal",
  "provider_event",
  "error",
  "decision",
  "execution",
  "human_decision",
  "proposal",
  "message",
];

const ALL_SEVERITIES = ["error", "warning", "info", "debug"];

// ── Component ────────────────────────────────────────────────────────────────

export default function AgentLogPage() {
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [severityFilter, setSeverityFilter] = useState<string>("");
  const [caseIdSearch, setCaseIdSearch] = useState<string>("");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [allEntries, setAllEntries] = useState<AgentLogEntry[]>([]);

  // Build query params
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", "200");
    if (sourceFilter) params.set("source", sourceFilter);
    if (kindFilter) params.set("kind", kindFilter);
    if (caseIdSearch) {
      const parsed = parseInt(caseIdSearch, 10);
      if (!isNaN(parsed) && parsed > 0) params.set("case_id", String(parsed));
    }
    if (cursor) params.set("before", cursor);
    return params.toString();
  }, [sourceFilter, kindFilter, caseIdSearch, cursor]);

  const { data, mutate, isLoading } = useSWR<AgentLogResponse>(
    `/monitor/agent-log?${queryParams}`,
    fetcher,
    {
      refreshInterval: cursor ? 0 : 30000, // Only auto-refresh on first page
      onSuccess: (newData) => {
        if (cursor) {
          setAllEntries((prev) => [...prev, ...newData.entries]);
        } else {
          setAllEntries(newData.entries);
        }
      },
    }
  );

  const summary = data?.summary;
  const nextBefore = data?.next_before;

  // Apply client-side severity filter
  const entries = useMemo(() => {
    if (!severityFilter) return allEntries;
    return allEntries.filter((e) => e.severity === severityFilter);
  }, [allEntries, severityFilter]);

  // Compute KPIs from summary
  const kpis = useMemo(() => {
    if (!summary) return { total: 0, errors: 0, warnings: 0, topSource: "---" };

    const total = Object.values(summary.by_source).reduce((a, b) => a + b, 0);
    const errors = summary.by_severity?.error || 0;
    const warnings = summary.by_severity?.warning || 0;

    let topSource = "---";
    let topCount = 0;
    for (const [src, count] of Object.entries(summary.by_source)) {
      if (count > topCount) {
        topSource = src;
        topCount = count;
      }
    }

    return { total, errors, warnings, topSource };
  }, [summary]);

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setSourceFilter("");
    setKindFilter("");
    setSeverityFilter("");
    setCaseIdSearch("");
    setCursor(null);
    setAllEntries([]);
  };

  const loadOlder = () => {
    if (nextBefore) setCursor(nextBefore);
  };

  const hasFilters = sourceFilter || kindFilter || severityFilter || caseIdSearch;

  return (
    <AdminGuard>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="h-6 w-6" />
              Agent Log
            </h1>
            <p className="text-sm text-muted-foreground">
              Global agent trace across all cases. Auto-refreshes every 30s.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCursor(null);
              setAllEntries([]);
              mutate();
            }}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" /> Total Entries
              </p>
              <p className="text-2xl font-bold">{kpis.total}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" /> Errors
              </p>
              <p
                className={cn(
                  "text-2xl font-bold",
                  kpis.errors > 0 ? "text-red-400" : "text-green-400"
                )}
              >
                {kpis.errors}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" /> Warnings
              </p>
              <p
                className={cn(
                  "text-2xl font-bold",
                  kpis.warnings > 0 ? "text-amber-400" : "text-green-400"
                )}
              >
                {kpis.warnings}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" /> Top Source
              </p>
              <p className="text-lg font-bold truncate" title={kpis.topSource}>
                {kpis.topSource}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Filter Bar */}
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Source</label>
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={sourceFilter}
                  onChange={(e) => {
                    setSourceFilter(e.target.value);
                    setCursor(null);
                    setAllEntries([]);
                  }}
                >
                  <option value="">All sources</option>
                  {ALL_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Kind</label>
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={kindFilter}
                  onChange={(e) => {
                    setKindFilter(e.target.value);
                    setCursor(null);
                    setAllEntries([]);
                  }}
                >
                  <option value="">All kinds</option>
                  {ALL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Severity</label>
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                >
                  <option value="">All severities</option>
                  {ALL_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
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
                    onChange={(e) => {
                      setCaseIdSearch(e.target.value);
                      setCursor(null);
                      setAllEntries([]);
                    }}
                  />
                </div>
              </div>
              {hasFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Entries Table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Entries
              <span className="text-xs text-muted-foreground font-normal ml-1">
                ({entries.length} shown)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && allEntries.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : entries.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Activity className="h-8 w-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No entries found.</p>
                <p className="text-xs mt-1">
                  {hasFilters
                    ? "Try adjusting your filters."
                    : "No agent activity recorded yet."}
                </p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <Table className="min-w-[900px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]" />
                        <TableHead>Timestamp</TableHead>
                        <TableHead className="w-[40px]" />
                        <TableHead>Source</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead>Case</TableHead>
                        <TableHead>Title</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entries.map((entry) => {
                        const isExpanded = expandedRows.has(entry.id);
                        return (
                          <TableRow
                            key={entry.id}
                            className="cursor-pointer hover:bg-muted/50 align-top"
                            onClick={() => toggleRow(entry.id)}
                          >
                            <TableCell className="pr-0">
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              )}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              <span title={new Date(entry.timestamp).toLocaleString()}>
                                {formatRelativeTime(entry.timestamp)}
                              </span>
                            </TableCell>
                            <TableCell className="px-0">
                              <span
                                className={cn(
                                  "inline-block h-2.5 w-2.5 rounded-full",
                                  severityDot(entry.severity)
                                )}
                                title={entry.severity}
                              />
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs font-mono",
                                  sourceColor(entry.source)
                                )}
                              >
                                {entry.source}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-xs font-mono",
                                  kindColor(entry.kind)
                                )}
                              >
                                {entry.kind}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {entry.case_id ? (
                                <Link
                                  href={`/requests/detail-v2?id=${entry.case_id}`}
                                  className="hover:underline text-primary text-xs"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  #{entry.case_id}
                                </Link>
                              ) : (
                                <span className="text-xs text-muted-foreground">---</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div>
                                <p className="text-xs">
                                  {isExpanded
                                    ? entry.title
                                    : truncateTitle(entry.title)}
                                </p>
                                {isExpanded && (
                                  <ExpandedEntryDetails entry={entry} />
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Pagination */}
                {nextBefore && (
                  <div className="flex justify-center pt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadOlder}
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1" />
                      ) : null}
                      Load older
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminGuard>
  );
}

// ── Expanded Details ─────────────────────────────────────────────────────────

function ExpandedEntryDetails({ entry }: { entry: AgentLogEntry }) {
  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      {/* Summary */}
      {entry.summary && (
        <p className="text-xs text-muted-foreground">{entry.summary}</p>
      )}

      {/* Metadata row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {entry.run_id && (
          <span>
            <strong>Run:</strong> {entry.run_id}
          </span>
        )}
        {entry.message_id && (
          <span>
            <strong>Message:</strong> {entry.message_id}
          </span>
        )}
        {entry.proposal_id && (
          <span>
            <strong>Proposal:</strong> {entry.proposal_id}
          </span>
        )}
        {entry.step && (
          <span>
            <strong>Step:</strong> {entry.step}
          </span>
        )}
        <span>
          <strong>Severity:</strong> {entry.severity}
        </span>
      </div>

      {/* Payload JSON */}
      {entry.payload && Object.keys(entry.payload).length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-muted-foreground mb-1">Payload</p>
          <pre className="text-[10px] leading-relaxed bg-muted/50 rounded-md p-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
            {JSON.stringify(entry.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
