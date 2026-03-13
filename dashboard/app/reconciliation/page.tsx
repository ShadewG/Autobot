"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { AdminGuard } from "@/components/admin-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fetcher, fetchAPI } from "@/lib/api";
import { formatDateTime, formatRelativeTime, cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  ChevronRight,
  Loader2,
  XCircle,
  AlertCircle,
  FileWarning,
  Inbox,
  Clock,
  Globe,
  Activity,
  Paperclip,
  ShieldAlert,
} from "lucide-react";

// --- Types matching backend response shape ---

interface DroppedAction {
  case_id: number;
  suggested_action: string;
  analysis_at: string;
  status: string;
  agency_name: string;
}

interface ProcessingError {
  message_id: number;
  case_id: number | null;
  from_email: string;
  subject: string;
  error: string;
  created_at: string;
}

interface UnanalyzedMessage {
  message_id: number;
  case_id: number | null;
  from_email: string;
  subject: string;
  created_at: string;
}

interface PortalMissing {
  case_id: number;
  case_name: string;
  agency_name: string;
  status: string;
  portal_url: string;
  engine: string | null;
  portal_status: string;
}

interface RunWithoutTrace {
  run_id: number;
  case_id: number;
  trigger_type: string;
  status: string;
  started_at: string;
}

interface DeadEndCase {
  case_id: number;
  agency_name: string;
  state: string;
  status: string;
  pause_reason: string | null;
  updated_at: string;
}

interface InboundLinkageGap {
  message_id: number;
  from_email: string;
  subject: string;
  thread_id: number | null;
  case_id: number | null;
  received_at: string;
}

interface EmptyNormalizedInbound {
  message_id: number;
  case_id: number | null;
  from_email: string;
  subject: string;
  thread_id: number | null;
  normalized_body_source: string | null;
  attachment_count: number;
  received_at: string;
}

interface ProposalMessageMismatch {
  proposal_id: number;
  proposal_case_id: number;
  proposal_status: string;
  trigger_message_id: number;
  message_case_id: number;
  proposal_agency_name: string | null;
  message_agency_name: string | null;
  subject: string;
  message_received_at: string;
}

interface ReconciliationReport {
  generated_at: string;
  dropped_actions: { count: number; cases: DroppedAction[] };
  processing_errors: { count: number; messages: ProcessingError[] };
  orphaned_inbound: number;
  stale_proposals: number;
  unanalyzed_inbound: { count: number; messages: UnanalyzedMessage[] };
  portal_missing_request_number: { count: number; cases: PortalMissing[] };
  runs_without_traces: { count: number; runs: RunWithoutTrace[] };
  attachment_extraction: {
    inbound_with_attachments: number;
    has_extraction: number;
    missing_extraction: number;
    extraction_rate: number | null;
  };
  dead_end_cases: { count: number; cases: DeadEndCase[] };
  blocked_import_cases: { count: number; cases: DeadEndCase[] };
  inbound_linkage_gaps: { count: number; messages: InboundLinkageGap[] };
  empty_normalized_inbound: { count: number; messages: EmptyNormalizedInbound[] };
  proposal_message_mismatches: { count: number; proposals: ProposalMessageMismatch[] };
}

interface ReconciliationResponse {
  success: boolean;
  report: ReconciliationReport;
}

// --- Section config ---

interface SectionConfig {
  key: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  getCount: (r: ReconciliationReport) => number;
}

const SECTIONS: SectionConfig[] = [
  {
    key: "dropped_actions",
    title: "Dropped Actions",
    description: "Analysis says 'requires action' but no proposal exists",
    icon: <XCircle className="h-4 w-4" />,
    getCount: (r) => r.dropped_actions.count,
  },
  {
    key: "dead_end_cases",
    title: "Dead End Cases",
    description: "Stuck in human review with no active proposal or run",
    icon: <ShieldAlert className="h-4 w-4" />,
    getCount: (r) => r.dead_end_cases.count,
  },
  {
    key: "blocked_import_cases",
    title: "Blocked Import Cases",
    description: "Intentionally parked intake cases awaiting contact info or human review",
    icon: <ShieldAlert className="h-4 w-4" />,
    getCount: (r) => r.blocked_import_cases.count,
  },
  {
    key: "unanalyzed_inbound",
    title: "Unanalyzed Inbound",
    description: "Inbound messages with no response analysis",
    icon: <Inbox className="h-4 w-4" />,
    getCount: (r) => r.unanalyzed_inbound.count,
  },
  {
    key: "processing_errors",
    title: "Processing Errors",
    description: "Messages that failed during processing",
    icon: <AlertCircle className="h-4 w-4" />,
    getCount: (r) => r.processing_errors.count,
  },
  {
    key: "runs_without_traces",
    title: "Runs Without Traces",
    description: "Agent runs from the last 7 days missing decision trace records",
    icon: <Activity className="h-4 w-4" />,
    getCount: (r) => r.runs_without_traces.count,
  },
  {
    key: "portal_missing_request_number",
    title: "Portal Request Number Gaps",
    description: "Completed portal submissions where a captured confirmation number was not written back",
    icon: <Globe className="h-4 w-4" />,
    getCount: (r) => r.portal_missing_request_number.count,
  },
  {
    key: "attachment_extraction",
    title: "Attachment Extraction",
    description: "Coverage rate for text extraction from attachments",
    icon: <Paperclip className="h-4 w-4" />,
    getCount: (r) => r.attachment_extraction.missing_extraction,
  },
  {
    key: "stale_proposals",
    title: "Review Backlog",
    description: "Human-review proposals pending approval for over 48 hours",
    icon: <Clock className="h-4 w-4" />,
    getCount: (r) => r.stale_proposals,
  },
  {
    key: "orphaned_inbound",
    title: "Orphaned Inbound",
    description: "Inbound messages not matched to any case",
    icon: <FileWarning className="h-4 w-4" />,
    getCount: (r) => r.orphaned_inbound,
  },
  {
    key: "inbound_linkage_gaps",
    title: "Inbound Linkage Gaps",
    description: "Recent inbound messages with no case, thread, proposal, or run linkage",
    icon: <FileWarning className="h-4 w-4" />,
    getCount: (r) => r.inbound_linkage_gaps.count,
  },
  {
    key: "empty_normalized_inbound",
    title: "Empty Normalized Inbound",
    description: "Recent inbound messages that normalized to empty text",
    icon: <AlertTriangle className="h-4 w-4" />,
    getCount: (r) => r.empty_normalized_inbound.count,
  },
  {
    key: "proposal_message_mismatches",
    title: "Proposal / Message Mismatch",
    description: "Proposal trigger message points at a different case than the proposal",
    icon: <ShieldAlert className="h-4 w-4" />,
    getCount: (r) => r.proposal_message_mismatches.count,
  },
];

// --- Components ---

function CaseLink({ caseId }: { caseId: number | null }) {
  if (caseId == null) return <span className="text-muted-foreground">--</span>;
  return (
    <Link
      href={`/requests/detail-v2?id=${caseId}`}
      className="text-blue-400 hover:text-blue-300 font-mono text-xs"
    >
      #{caseId}
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className="text-[10px] font-normal">
      {status}
    </Badge>
  );
}

function SectionCard({
  config,
  report,
}: {
  config: SectionConfig;
  report: ReconciliationReport;
}) {
  const [open, setOpen] = useState(false);
  const count = config.getCount(report);
  const isClean = count === 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card
        className={cn(
          "transition-colors",
          isClean
            ? "border-green-500/20 bg-green-500/5"
            : "border-red-500/20 bg-red-500/5"
        )}
      >
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer select-none pb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg",
                    isClean
                      ? "bg-green-500/10 text-green-400"
                      : "bg-red-500/10 text-red-400"
                  )}
                >
                  {config.icon}
                </div>
                <div>
                  <CardTitle className="text-sm font-medium">
                    {config.title}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {config.description}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={isClean ? "outline" : "destructive"}
                  className={cn(
                    "text-xs tabular-nums",
                    isClean && "border-green-500/30 text-green-400"
                  )}
                >
                  {count}
                </Badge>
                <ChevronRight
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    open && "rotate-90"
                  )}
                />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <SectionDetail sectionKey={config.key} report={report} />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function SectionDetail({
  sectionKey,
  report,
}: {
  sectionKey: string;
  report: ReconciliationReport;
}) {
  switch (sectionKey) {
    case "dropped_actions":
      return <DroppedActionsDetail items={report.dropped_actions.cases} />;
    case "dead_end_cases":
      return <DeadEndCasesDetail items={report.dead_end_cases.cases} />;
    case "blocked_import_cases":
      return <DeadEndCasesDetail items={report.blocked_import_cases.cases} />;
    case "unanalyzed_inbound":
      return (
        <UnanalyzedInboundDetail items={report.unanalyzed_inbound.messages} />
      );
    case "processing_errors":
      return (
        <ProcessingErrorsDetail items={report.processing_errors.messages} />
      );
    case "runs_without_traces":
      return (
        <RunsWithoutTracesDetail items={report.runs_without_traces.runs} />
      );
    case "portal_missing_request_number":
      return (
        <PortalMissingDetail
          items={report.portal_missing_request_number.cases}
        />
      );
    case "attachment_extraction":
      return (
        <AttachmentExtractionDetail data={report.attachment_extraction} />
      );
    case "stale_proposals":
      return (
        <SimpleCountDetail
          label="proposals pending > 48h"
          count={report.stale_proposals}
        />
      );
    case "orphaned_inbound":
      return (
        <SimpleCountDetail
          label="inbound messages without a case"
          count={report.orphaned_inbound}
        />
      );
    case "inbound_linkage_gaps":
      return <InboundLinkageGapsDetail items={report.inbound_linkage_gaps.messages} />;
    case "empty_normalized_inbound":
      return <EmptyNormalizedInboundDetail items={report.empty_normalized_inbound.messages} />;
    case "proposal_message_mismatches":
      return <ProposalMessageMismatchDetail items={report.proposal_message_mismatches.proposals} />;
    default:
      return null;
  }
}

function DroppedActionsDetail({ items }: { items: DroppedAction[] }) {
  if (items.length === 0)
    return <EmptyMessage message="No dropped actions found." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-3">
            <CaseLink caseId={item.case_id} />
            <span className="text-muted-foreground truncate max-w-[200px]">
              {item.agency_name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {item.suggested_action}
            </Badge>
            <StatusBadge status={item.status} />
            <span className="text-muted-foreground">
              {formatRelativeTime(item.analysis_at)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DeadEndCasesDetail({ items }: { items: DeadEndCase[] }) {
  if (items.length === 0)
    return <EmptyMessage message="No dead end cases found." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-3">
            <CaseLink caseId={item.case_id} />
            <span className="text-muted-foreground truncate max-w-[200px]">
              {item.agency_name}
            </span>
            {item.state && (
              <Badge variant="outline" className="text-[10px]">
                {item.state}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={item.status} />
            {item.pause_reason && (
              <Badge
                variant="outline"
                className="text-[10px] text-amber-400 border-amber-500/30"
              >
                {item.pause_reason}
              </Badge>
            )}
            <span className="text-muted-foreground">
              {formatRelativeTime(item.updated_at)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function UnanalyzedInboundDetail({ items }: { items: UnanalyzedMessage[] }) {
  if (items.length === 0)
    return <EmptyMessage message="All inbound messages have been analyzed." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-3">
            <CaseLink caseId={item.case_id} />
            <span className="text-muted-foreground truncate max-w-[160px]">
              {item.from_email}
            </span>
            <span className="truncate max-w-[200px]">{item.subject}</span>
          </div>
          <span className="text-muted-foreground">
            {formatRelativeTime(item.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function InboundLinkageGapsDetail({ items }: { items: InboundLinkageGap[] }) {
  if (items.length === 0) return <EmptyMessage message="No recent inbound linkage gaps found." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs">
          <div className="flex items-center gap-3 overflow-hidden">
            <span className="font-mono text-muted-foreground">#{item.message_id}</span>
            <span className="text-muted-foreground truncate max-w-[240px]">{item.from_email}</span>
            <span className="text-muted-foreground truncate max-w-[280px]">{item.subject || "(no subject)"}</span>
          </div>
          <div className="flex items-center gap-2">
            {item.thread_id ? <Badge variant="outline" className="text-[10px]">thread #{item.thread_id}</Badge> : null}
            <span className="text-muted-foreground">{formatRelativeTime(item.received_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyNormalizedInboundDetail({ items }: { items: EmptyNormalizedInbound[] }) {
  if (items.length === 0) return <EmptyMessage message="All recent inbound messages normalized correctly." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs">
          <div className="flex items-center gap-3 overflow-hidden">
            <span className="font-mono text-muted-foreground">#{item.message_id}</span>
            <CaseLink caseId={item.case_id} />
            <span className="text-muted-foreground truncate max-w-[200px]">{item.from_email}</span>
            <span className="text-muted-foreground truncate max-w-[260px]">{item.subject || "(no subject)"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {item.normalized_body_source || "empty"}
            </Badge>
            {item.attachment_count > 0 ? (
              <Badge variant="outline" className="text-[10px]">
                {item.attachment_count} attachment{item.attachment_count === 1 ? "" : "s"}
              </Badge>
            ) : null}
            <span className="text-muted-foreground">{formatRelativeTime(item.received_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProposalMessageMismatchDetail({ items }: { items: ProposalMessageMismatch[] }) {
  if (items.length === 0) return <EmptyMessage message="No proposal/message case mismatches found." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs">
          <div className="flex items-center gap-3 overflow-hidden">
            <span className="font-mono text-muted-foreground">P#{item.proposal_id}</span>
            <CaseLink caseId={item.proposal_case_id} />
            <span className="text-muted-foreground">vs</span>
            <CaseLink caseId={item.message_case_id} />
            <span className="text-muted-foreground truncate max-w-[260px]">{item.subject || "(no subject)"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">{item.proposal_status}</Badge>
            <span className="text-muted-foreground">{formatRelativeTime(item.message_received_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProcessingErrorsDetail({ items }: { items: ProcessingError[] }) {
  if (items.length === 0)
    return <EmptyMessage message="No processing errors found." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="rounded-md border border-border/50 px-3 py-2 text-xs space-y-1"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CaseLink caseId={item.case_id} />
              <span className="text-muted-foreground truncate max-w-[160px]">
                {item.from_email}
              </span>
              <span className="truncate max-w-[200px]">{item.subject}</span>
            </div>
            <span className="text-muted-foreground">
              {formatRelativeTime(item.created_at)}
            </span>
          </div>
          <p className="text-red-400 text-[11px] font-mono">{item.error}</p>
        </div>
      ))}
    </div>
  );
}

function RunsWithoutTracesDetail({ items }: { items: RunWithoutTrace[] }) {
  if (items.length === 0)
    return <EmptyMessage message="All recent runs have decision traces." />;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-3">
            <CaseLink caseId={item.case_id} />
            <span className="font-mono text-muted-foreground">
              run #{item.run_id}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {item.trigger_type}
            </Badge>
            <StatusBadge status={item.status} />
            <span className="text-muted-foreground">
              {formatRelativeTime(item.started_at)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function PortalMissingDetail({ items }: { items: PortalMissing[] }) {
  if (items.length === 0)
    return (
      <EmptyMessage message="All portal cases have request numbers." />
    );
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-3">
            <CaseLink caseId={item.case_id} />
            <span className="text-muted-foreground truncate max-w-[180px]">
              {item.agency_name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={item.status} />
            {item.engine && (
              <Badge variant="outline" className="text-[10px]">
                {item.engine}
              </Badge>
            )}
            {item.portal_status && (
              <span className="text-muted-foreground truncate max-w-[120px]">
                {item.portal_status}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AttachmentExtractionDetail({
  data,
}: {
  data: ReconciliationReport["attachment_extraction"];
}) {
  const rate = data.extraction_rate != null ? (data.extraction_rate * 100).toFixed(1) : "--";
  const isGood = data.missing_extraction === 0;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="rounded-md border border-border/50 px-3 py-2 text-center">
        <p className="text-lg font-semibold tabular-nums">
          {data.inbound_with_attachments}
        </p>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Total w/ Attachments
        </p>
      </div>
      <div className="rounded-md border border-border/50 px-3 py-2 text-center">
        <p className="text-lg font-semibold tabular-nums text-green-400">
          {data.has_extraction}
        </p>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Extracted
        </p>
      </div>
      <div className="rounded-md border border-border/50 px-3 py-2 text-center">
        <p
          className={cn(
            "text-lg font-semibold tabular-nums",
            isGood ? "text-green-400" : "text-red-400"
          )}
        >
          {data.missing_extraction}
        </p>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Missing
        </p>
      </div>
      <div className="rounded-md border border-border/50 px-3 py-2 text-center">
        <p
          className={cn(
            "text-lg font-semibold tabular-nums",
            isGood ? "text-green-400" : "text-amber-400"
          )}
        >
          {rate}%
        </p>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Coverage Rate
        </p>
      </div>
    </div>
  );
}

function SimpleCountDetail({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  if (count === 0)
    return <EmptyMessage message={`No ${label} found.`} />;
  return (
    <p className="text-xs text-muted-foreground">
      <span className="text-red-400 font-semibold tabular-nums">{count}</span>{" "}
      {label}
    </p>
  );
}

function EmptyMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-green-400">
      <CheckCircle className="h-3.5 w-3.5" />
      {message}
    </div>
  );
}

// --- Main Page ---

export default function ReconciliationPage() {
  const [isRunning, setIsRunning] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<ReconciliationResponse>(
    "/eval/reconciliation",
    fetcher,
    { refreshInterval: 0 }
  );

  const report = data?.report;

  async function handleRunReconciliation() {
    setIsRunning(true);
    try {
      const freshData = await fetchAPI<ReconciliationResponse>(
        "/eval/reconciliation"
      );
      mutate(freshData, false);
      toast.success("Reconciliation report refreshed");
    } catch (err: unknown) {
      toast.error(
        `Failed to refresh: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setIsRunning(false);
    }
  }

  // Compute summary stats
  const totalIssues = report
    ? SECTIONS.reduce((sum, s) => sum + s.getCount(report), 0)
    : 0;
  const categoriesWithIssues = report
    ? SECTIONS.filter((s) => s.getCount(report) > 0).length
    : 0;
  const cleanCategories = report
    ? SECTIONS.length - categoriesWithIssues
    : 0;

  return (
    <AdminGuard>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Reconciliation Report
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            System health check: dropped actions, processing gaps, and orphaned
            data
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRunReconciliation}
          disabled={isRunning || isLoading}
        >
          {isRunning ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
          )}
          Run Reconciliation
        </Button>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="py-6">
            <div className="flex items-center gap-2 text-red-400 text-sm">
              <AlertTriangle className="h-4 w-4" />
              Failed to load reconciliation report:{" "}
              {error instanceof Error ? error.message : "Unknown error"}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Report content */}
      {report && !isLoading && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Card>
              <CardContent className="py-4">
                <p
                  className={cn(
                    "text-2xl font-bold tabular-nums",
                    totalIssues === 0 ? "text-green-400" : "text-red-400"
                  )}
                >
                  {totalIssues}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Total Issues
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p
                  className={cn(
                    "text-2xl font-bold tabular-nums",
                    categoriesWithIssues === 0
                      ? "text-green-400"
                      : "text-amber-400"
                  )}
                >
                  {categoriesWithIssues}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Categories With Issues
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-2xl font-bold tabular-nums text-green-400">
                  {cleanCategories}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Clean Categories
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <p className="text-sm font-medium tabular-nums">
                  {formatDateTime(report.generated_at)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Last Run
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Section cards — sorted by count descending so highest-impact issues surface first */}
          <div className="space-y-3">
            {[...SECTIONS]
              .sort((a, b) => b.getCount(report) - a.getCount(report))
              .map((config) => (
              <SectionCard
                key={config.key}
                config={config}
                report={report}
              />
            ))}
          </div>
        </>
      )}
    </div>
    </AdminGuard>
  );
}
