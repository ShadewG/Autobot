"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useRef, Suspense, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { LinkifiedText } from "@/components/linkified-text";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { DueDisplay } from "@/components/due-display";
import { Timeline } from "@/components/timeline";
import { Thread } from "@/components/thread";
import { Composer } from "@/components/composer";
import { CopilotPanel } from "@/components/copilot-panel";
import { ScopeSummary } from "@/components/scope-table";
import { ConstraintsDisplay } from "@/components/constraints-display";
import { FeeBreakdown } from "@/components/fee-breakdown";
import { ExemptionClaimsList } from "@/components/exemption-claim-card";
import { AdjustModal } from "@/components/adjust-modal";
import { DecisionPanel } from "@/components/decision-panel";
import { DeadlineCalculator } from "@/components/deadline-calculator";
import { requestsAPI, casesAPI, fetcher, fetchAPI, type AgentRun } from "@/lib/api";
import type {
  RequestWorkspaceResponse,
  NextAction,
  AgentDecision,
  CaseAgency,
  AgencyCandidate,
  ThreadMessage,
  PendingProposal,
} from "@/lib/types";
import { formatDate, formatRelativeTime, cn, formatReasoning, ACTION_TYPE_LABELS, formatCurrency, isTrackingUrl, stripHtmlTags } from "@/lib/utils";
import {
  ArrowUp,
  ArrowLeft,
  Loader2,
  Clock,
  MoreHorizontal,
  Ban,
  AlarmClock,
  Globe,
  Mail,
  DollarSign,
  FileQuestion,
  XCircle,
  UserCheck,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Play,
  Bot,
  Send,
  ChevronDown,
  RefreshCw,
  Inbox,
  RotateCcw,
  Activity,
  ClipboardPaste,
  Phone,
  Edit,
  Trash2,
  Copy,
  Check,
  ChevronRight,
  ArrowRight,
  GripVertical,
  Search,
  Paperclip,
  Tag,
  X,
  Plus,
  Download,
  Bug,
  FileText,
  Brain,
} from "lucide-react";
import { ProposalStatus, type ProposalState } from "@/components/proposal-status";
import { AttachmentPicker } from "@/components/attachment-picker";
import { SnoozeModal } from "@/components/snooze-modal";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AutopilotSelector } from "@/components/autopilot-selector";
import { SafetyHints } from "@/components/safety-hints";
import { PasteInboundDialog } from "@/components/paste-inbound-dialog";
import { AddCorrespondenceDialog } from "@/components/add-correspondence-dialog";
import { CaseInfoTab } from "@/components/case-info-tab";
import { PortalLiveView } from "@/components/portal-live-view";
import { useAuth } from "@/components/auth-provider";
import { toast } from "sonner";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DISMISS_REASONS = [
  "Wrong action",
  "Already handled",
  "Duplicate",
  "Bad timing",
  "Not needed",
];

const EMAIL_ACTION_TYPES = [
  "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_CLARIFICATION", "SEND_REBUTTAL",
  "NEGOTIATE_FEE", "ACCEPT_FEE", "DECLINE_FEE", "SEND_PDF_EMAIL",
  "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE",
  "RESPOND_PARTIAL_APPROVAL", "REFORMULATE_REQUEST",
];

interface DraftState {
  editedBody: string;
  editedSubject: string;
  editedRecipient: string;
  editedChainSubject: string;
  editedChainBody: string;
  proposalAttachments: Array<{ filename: string; content: string; type: string }>;
}


function getControlStateDisplay(controlState?: string | null) {
  const key = String(controlState || "").toUpperCase();
  switch (key) {
    case "WORKING":
      return { label: "Working", className: "border-blue-700/50 bg-blue-500/10 text-blue-300", icon: Loader2 };
    case "NEEDS_DECISION":
      return { label: "Needs Decision", className: "border-amber-700/50 bg-amber-500/10 text-amber-300", icon: Clock };
    case "WAITING_AGENCY":
      return { label: "Waiting on Agency", className: "border-emerald-700/50 bg-emerald-500/10 text-emerald-300", icon: CheckCircle };
    case "DONE":
      return { label: "Done", className: "border-emerald-700/50 bg-emerald-500/10 text-emerald-300", icon: CheckCircle };
    case "OUT_OF_SYNC":
      return { label: "Out of Sync", className: "border-red-700/50 bg-red-500/10 text-red-300", icon: AlertTriangle };
    default:
      return { label: "Blocked", className: "border-yellow-700/50 bg-yellow-500/10 text-yellow-300", icon: AlertTriangle };
  }
}

function formatLiveRunLabel(run: AgentRun | null): string | null {
  if (!run) return null;
  const status = (run.status || "").toLowerCase();
  const trigger = (run.trigger_type || "").toLowerCase();
  const node = typeof run.metadata?.current_node === "string" ? String(run.metadata?.current_node) : "";
  let action = "working";
  if (trigger.includes("human_review_resolution")) action = "applying review decision";
  else if (trigger.includes("human_review")) action = "processing approval";
  else if (trigger.includes("inbound")) action = "processing inbound";
  else if (trigger.includes("followup")) action = "processing follow-up";
  else if (trigger.includes("portal")) action = "processing portal";
  else if (trigger.includes("initial")) action = "building initial request";
  if (node) {
    const knownNodes: Record<string, string> = {
      load_context: "loading context", classify_inbound: "classifying", decide_action: "deciding",
      research_context: "researching", draft_response: "drafting", draft_initial_request: "drafting initial",
      create_proposal_gate: "creating proposal", wait_human_decision: "waiting for decision",
      execute_action: "executing", commit_state: "saving", schedule_followups: "scheduling",
      safety_check: "safety check", complete: "completed", failed: "failed",
    };
    action = knownNodes[node.toLowerCase()] || node.replace(/[_-]/g, " ");
  }
  if (status === "waiting") return "Paused: awaiting decision";
  if (status === "queued" || status === "created") return `Queued: ${action}`;
  if (status === "running" || status === "processing") return `Running: ${action}`;
  return null;
}

function buildTriggerRunUrl(triggerRunId?: string | null): string | null {
  if (!triggerRunId) return null;
  return `https://cloud.trigger.dev/orgs/frontwind-llc-27ae/projects/autobot-Z-SQ/env/prod/runs/${triggerRunId}`;
}

function getDeliveryTarget(
  actionType: string | null,
  request: RequestWorkspaceResponse["request"],
  agency: RequestWorkspaceResponse["agency_summary"] | null
): { method: string; target: string | null } | null {
  if (!actionType) return null;
  if (actionType === "SUBMIT_PORTAL") {
    return { method: "PORTAL", target: request.portal_url || agency?.portal_url || null };
  }
  if (["SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_CLARIFICATION", "SEND_REBUTTAL",
    "NEGOTIATE_FEE", "ACCEPT_FEE", "DECLINE_FEE", "SEND_PDF_EMAIL"].includes(actionType)) {
    return { method: "EMAIL", target: request.agency_email || null };
  }
  return null;
}

function resolveManualRequestUrl(caseUrl: string | null | undefined, agencyUrl?: string | null): string | null {
  if (caseUrl) return caseUrl;
  if (agencyUrl) return agencyUrl;
  return null;
}

function resolvePdfFormUrl(caseUrl: string | null | undefined, agencyUrl?: string | null): string | null {
  if (caseUrl) return caseUrl;
  if (agencyUrl) return agencyUrl;
  return null;
}

function getProposalApproveLabel(actionType: string | null, actionChainLength = 0): string {
  if (actionChainLength > 1) return `Approve ${actionChainLength} Actions`;
  if (actionType === "ACCEPT_FEE") return "Accept Fee";
  if (actionType && EMAIL_ACTION_TYPES.includes(actionType)) return "Send";
  return "Approve";
}

function daysOpen(submittedAt: string | null | undefined): string {
  if (!submittedAt) return "—";
  const d = new Date(submittedAt);
  if (isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  return `${days}d`;
}

function daysUntilDue(dueAt: string | null | undefined): string | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  if (isNaN(d.getTime())) return null;
  const diff = Math.floor((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  return `Due ${diff}d`;
}

function resolvePortalUrl(caseUrl: string | null, agencyUrl: string | null): string | null {
  if (caseUrl && !isTrackingUrl(caseUrl)) return caseUrl;
  if (agencyUrl && !isTrackingUrl(agencyUrl)) return agencyUrl;
  return null;
}

function AgencyStatsBar({ agencyId }: { agencyId: string | number }) {
  const { data } = useSWR<{ success: boolean; agency: { stats: { total_requests: number; completed_requests: number; avg_response_days: number | null; has_fees: number; total_fees: number }; fee_behavior: { typical_fee_range: string | null; waiver_success_rate: number | null } } }>(
    `/agencies/${agencyId}`,
    fetcher,
    { revalidateOnFocus: false }
  );
  const stats = data?.agency?.stats;
  if (!stats || stats.total_requests === 0) return null;
  const completionRate = stats.total_requests > 0 ? Math.round((stats.completed_requests / stats.total_requests) * 100) : 0;
  const feeBehavior = data?.agency?.fee_behavior;
  return (
    <div className="text-[10px] space-y-1.5 pt-1.5 border-t border-border/30">
      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Track Record</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Cases</span>
          <span className="font-medium">{stats.total_requests}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Completed</span>
          <span className={cn("font-medium", completionRate >= 50 ? "text-green-400" : completionRate > 0 ? "text-amber-400" : "")}>{completionRate}%</span>
        </div>
        {stats.avg_response_days != null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Avg response</span>
            <span className="font-medium">{stats.avg_response_days}d</span>
          </div>
        )}
        {stats.has_fees > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fee cases</span>
            <span className="font-medium">{stats.has_fees}</span>
          </div>
        )}
        {feeBehavior?.typical_fee_range && (
          <div className="flex justify-between col-span-2">
            <span className="text-muted-foreground">Typical fees</span>
            <span className="font-medium">{feeBehavior.typical_fee_range}</span>
          </div>
        )}
        {feeBehavior?.waiver_success_rate != null && feeBehavior.waiver_success_rate > 0 && (
          <div className="flex justify-between col-span-2">
            <span className="text-muted-foreground">Fee waiver rate</span>
            <span className="font-medium">{Math.round(feeBehavior.waiver_success_rate * 100)}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

function extractManualPdfEscalation(reasoning: string[] | null | undefined) {
  const lines = formatReasoning(reasoning || [], 8);
  const instruction =
    lines.find((line) => /human should complete .*\.pdf manually and send/i.test(String(line))) || null;
  if (!instruction) return null;
  const attachmentMatch = String(instruction).match(/complete\s+(.+?\.pdf)\s+manually/i);
  const failureLine =
    lines.find((line) => /automatic pdf form preparation failed:/i.test(String(line))) || null;
  return {
    instruction: String(instruction),
    attachmentName: attachmentMatch?.[1] || null,
    failureReason: failureLine
      ? String(failureLine).replace(/^automatic pdf form preparation failed:\s*/i, "")
      : null,
  };
}

// ── Multi-agency helpers ─────────────────────────────────────────────────────

function parseEmailList(value?: string | null): string[] {
  if (!value) return [];
  return String(value)
    .split(/[,\s;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.includes("@"));
}

function emailDomain(email?: string | null): string | null {
  if (!email || !email.includes("@")) return null;
  return email.split("@").pop()?.trim().toLowerCase() || null;
}

function normalizeAgencyKey(name?: string | null): string[] {
  if (!name) return [];
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !["police", "department", "office", "county", "city", "records"].includes(token));
}

function messageMatchesAgency(message: RequestWorkspaceResponse["thread_messages"][number], agency: CaseAgency): boolean {
  if (message.case_agency_id != null) {
    return Number(message.case_agency_id) === Number(agency.id);
  }

  const agencyEmails = parseEmailList(agency.agency_email);
  const from = String(message.from_email || "").trim().toLowerCase();
  const to = String(message.to_email || "").trim().toLowerCase();
  const fromDomain = emailDomain(from);
  const toDomain = emailDomain(to);

  if (agencyEmails.some((email) => email === from || email === to)) {
    return true;
  }

  const agencyDomains = agencyEmails
    .map((email) => emailDomain(email))
    .filter((d): d is string => Boolean(d));
  if (agencyDomains.some((d) => d === fromDomain || d === toDomain)) {
    return true;
  }

  const searchableText = `${message.subject || ""}\n${message.body || ""}`.toLowerCase();
  const agencyTokens = normalizeAgencyKey(agency.agency_name);
  if (agencyTokens.length > 0 && agencyTokens.some((token) => searchableText.includes(token))) {
    return true;
  }

  return false;
}

// ── Section header style ─────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium px-3 pt-2.5 pb-1">
      {children}
    </h3>
  );
}

function CollapsibleSection({ title, defaultOpen = true, count, action, children }: {
  title: string;
  defaultOpen?: boolean;
  count?: number | null;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen || undefined} className="border-b border-border/50 group">
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 shrink-0" />
        {title}
        {count != null && <span className="ml-auto text-muted-foreground">{count}</span>}
      </summary>
      {action && (
        <div className="px-3 -mt-1 mb-1 flex justify-end" onClick={(e) => e.stopPropagation()}>
          {action}
        </div>
      )}
      <div className="px-3 pb-2">{children}</div>
    </details>
  );
}

// ── Event Ledger types & helpers ──────────────────────────────────────────

interface EventLedgerRow {
  id: number;
  case_id: number;
  event: string;
  transition_key: string | null;
  context: Record<string, any> | null;
  mutations_applied: Record<string, any> | null;
  projection: Record<string, any> | null;
  created_at: string;
}

function eventTypeColor(event: string): string {
  const e = event.toUpperCase();
  if (e.includes("ERROR") || e.includes("FAIL") || e.includes("BOUNCE")) return "text-red-400 bg-red-500/10 border-red-700/40";
  if (e.includes("NOTIF") || e.includes("ALERT") || e.includes("WARN") || e.includes("EMAIL_EVENT")) return "text-yellow-400 bg-yellow-500/10 border-yellow-700/40";
  // State transitions / default = blue
  return "text-blue-400 bg-blue-500/10 border-blue-700/40";
}

function eventDotColor(event: string): string {
  const e = event.toUpperCase();
  if (e.includes("ERROR") || e.includes("FAIL") || e.includes("BOUNCE")) return "bg-red-400";
  if (e.includes("NOTIF") || e.includes("ALERT") || e.includes("WARN") || e.includes("EMAIL_EVENT")) return "bg-yellow-400";
  return "bg-blue-400";
}

function summarizeContext(context: Record<string, any> | null): string | null {
  if (!context || typeof context !== "object") return null;
  const parts: string[] = [];
  // Pick the most useful keys
  const interestingKeys = ["action", "status", "from_status", "to_status", "trigger_type", "reason", "decision", "action_type", "proposal_id", "run_id", "error", "message"];
  for (const key of interestingKeys) {
    if (context[key] !== undefined && context[key] !== null) {
      const val = typeof context[key] === "object" ? JSON.stringify(context[key]) : String(context[key]);
      if (val.length < 120) parts.push(`${key}: ${val}`);
    }
  }
  if (parts.length === 0) {
    // Fallback: show first few keys
    const keys = Object.keys(context).slice(0, 3);
    for (const key of keys) {
      const val = typeof context[key] === "object" ? JSON.stringify(context[key]) : String(context[key]);
      if (val.length < 120) parts.push(`${key}: ${val}`);
    }
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

function EventLedgerSection({ caseId }: { caseId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [events, setEvents] = useState<EventLedgerRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen && !hasLoaded) {
      setIsLoading(true);
      setError(null);
      try {
        const data = await fetcher<{ success: boolean; count: number; events: EventLedgerRow[] }>(
          `/requests/${caseId}/event-ledger`
        );
        setEvents(data.events || []);
        setHasLoaded(true);
      } catch (err: any) {
        setError(err?.message || "Failed to load events");
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <details open={isOpen || undefined} className="border-b border-border/50 group" onToggle={(e) => {
      const open = (e.target as HTMLDetailsElement).open;
      if (open && !isOpen) handleToggle();
      else if (!open && isOpen) setIsOpen(false);
    }}>
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 shrink-0" />
        Event Ledger
        {hasLoaded && <span className="ml-auto text-muted-foreground">{events.length}</span>}
      </summary>
      <div className="px-3 pb-2">
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading events...
          </div>
        )}
        {error && (
          <div className="text-[10px] text-red-400 py-2">{error}</div>
        )}
        {hasLoaded && events.length === 0 && !isLoading && (
          <div className="text-[10px] text-muted-foreground py-2">No events recorded</div>
        )}
        {hasLoaded && events.length > 0 && (
          <div className="relative space-y-0">
            {/* Timeline line */}
            <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border/50" />
            {events.map((evt) => {
              const ctx = summarizeContext(evt.context);
              return (
                <div key={evt.id} className="relative pl-5 py-1.5 group/evt">
                  {/* Dot */}
                  <div className={cn("absolute left-[3px] top-[10px] h-[5px] w-[5px] rounded-full", eventDotColor(evt.event))} />
                  {/* Content */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={cn("text-[10px] font-medium px-1 py-0.5 rounded border", eventTypeColor(evt.event))}>
                          {evt.event}
                        </span>
                        {evt.transition_key && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {evt.transition_key}
                          </span>
                        )}
                      </div>
                      {ctx && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 truncate" title={ctx}>
                          {ctx}
                        </div>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                      {formatRelativeTime(evt.created_at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

// ── Portal Submissions Section ────────────────────────────────────────────

interface PortalSubmission {
  id: number;
  case_id: number;
  run_id: number | null;
  skyvern_task_id: string | null;
  status: string;
  engine: string | null;
  account_email: string | null;
  screenshot_url: string | null;
  recording_url: string | null;
  browser_backend: string | null;
  browser_session_id: string | null;
  browser_session_url: string | null;
  browser_debugger_url: string | null;
  browser_debugger_fullscreen_url: string | null;
  browser_region: string | null;
  browser_status: string | null;
  browser_metadata: Record<string, unknown> | null;
  browser_live_urls_jsonb: Record<string, unknown> | null;
  browser_logs_synced_at: string | null;
  auth_context_id: string | null;
  auth_intervention_status: string | null;
  auth_intervention_reason: string | null;
  auth_intervention_requested_at: string | null;
  auth_intervention_completed_at: string | null;
  browser_keep_alive: boolean | null;
  browser_cost_policy: Record<string, unknown> | string | null;
  extracted_data: Record<string, unknown> | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

interface PortalSessionEvent {
  id: number;
  event_index: number;
  method: string;
  page_id: number | null;
  level: string | null;
  url: string | null;
  status_code: number | null;
  message: string | null;
  occurred_at: string | null;
}

interface PortalSessionEventsResponse {
  success: boolean;
  case_id: number;
  submission: PortalSubmission;
  count: number;
  refreshed: boolean;
  events: PortalSessionEvent[];
}

function normalizeBrowserCostPolicy(value: PortalSubmission["browser_cost_policy"]): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function portalStatusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "completed" || s === "success" || s === "succeeded")
    return <Badge className="bg-green-500/15 text-green-400 border-green-500/30 text-[10px] px-1 py-0">{status}</Badge>;
  if (s === "failed" || s === "error")
    return <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px] px-1 py-0">{status}</Badge>;
  if (s === "pending" || s === "queued" || s === "created")
    return <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-[10px] px-1 py-0">{status}</Badge>;
  if (s === "in_progress" || s === "running" || s === "processing")
    return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-[10px] px-1 py-0">{status}</Badge>;
  return <Badge variant="outline" className="text-[10px] px-1 py-0">{status}</Badge>;
}

function humanizePortalLabel(value: string | null | undefined, fallback = "\u2014"): string {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getPortalSubmissionHeadline(submission: PortalSubmission): string {
  if (submission.error_message) return submission.error_message;

  const extracted = submission.extracted_data && typeof submission.extracted_data === "object"
    ? submission.extracted_data
    : null;

  if (extracted) {
    const preview = Object.entries(extracted)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .slice(0, 3)
      .map(([key, value]) => `${humanizePortalLabel(key)}: ${String(value)}`);
    if (preview.length > 0) return preview.join(" · ");
  }

  if (String(submission.status || "").toLowerCase().includes("dry_run")) {
    return "Dry run completed without sending the real portal submission.";
  }

  return "Portal automation attempt recorded for this case.";
}

function isDryRunSubmission(submission: PortalSubmission): boolean {
  const status = String(submission.status || "").toLowerCase();
  const engine = String(submission.engine || "").toLowerCase();
  return status.includes("dry_run") || engine.includes("dry run") || engine.includes("dry_run");
}

function PortalSubmissionScreenshot({
  url,
  alt,
}: {
  url: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!url) return null;

  if (failed) {
    return (
      <div className="text-[11px] text-muted-foreground">Screenshot unavailable</div>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block overflow-hidden rounded-2xl border border-border/60 bg-black/30"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt}
        className="h-44 w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
        onError={() => setFailed(true)}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 text-xs text-white/85">
        Portal screenshot
      </div>
    </a>
  );
}

function PortalAuthResumeButton({
  caseId,
  submission,
  onCompleted,
}: {
  caseId: string;
  submission: PortalSubmission;
  onCompleted: () => Promise<void> | void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleClick = useCallback(async () => {
    setIsSubmitting(true);
    try {
      await fetchAPI(`/requests/${caseId}/portal-submissions/${submission.id}/complete-auth`, {
        method: "POST",
      });
      toast.success("Portal auth marked complete. The worker is resuming the submission now.");
      await onCompleted();
    } catch (error: any) {
      toast.error(error?.message || "Failed to resume the portal submission");
    } finally {
      setIsSubmitting(false);
    }
  }, [caseId, onCompleted, submission.id]);

  return (
    <Button
      type="button"
      size="sm"
      className="h-8 rounded-full bg-cyan-500/20 px-3 text-[11px] text-cyan-100 hover:bg-cyan-500/30"
      onClick={handleClick}
      disabled={isSubmitting}
    >
      {isSubmitting ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />}
      Complete Auth & Retry
    </Button>
  );
}

function BrowserbaseSessionDialog({
  caseId,
  submission,
}: {
  caseId: string;
  submission: PortalSubmission;
}) {
  const [open, setOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const endpoint = open && submission.browser_session_id
    ? `/requests/${caseId}/portal-submissions/${submission.id}/session-events`
    : null;
  const { data, error, isLoading, mutate } = useSWR<PortalSessionEventsResponse>(
    endpoint,
    fetcher,
    { revalidateOnFocus: false }
  );

  const activeSubmission = data?.submission || submission;
  const events = data?.events || [];
  const liveViewUrl =
    activeSubmission.browser_debugger_url ||
    activeSubmission.browser_debugger_fullscreen_url ||
    null;

  const handleRefresh = useCallback(async () => {
    if (!submission.browser_session_id) return;
    setIsRefreshing(true);
    try {
      const refreshed = await fetchAPI<PortalSessionEventsResponse>(
        `/requests/${caseId}/portal-submissions/${submission.id}/session-events?refresh=true`
      );
      await mutate(refreshed, false);
    } finally {
      setIsRefreshing(false);
    }
  }, [caseId, mutate, submission.browser_session_id, submission.id]);

  if (!submission.browser_session_id) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="text-blue-400 hover:underline inline-flex items-center gap-1"
        onClick={() => setOpen(true)}
      >
        <Activity className="h-2.5 w-2.5" /> Logs
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Browser Session
              <Badge variant="outline" className="capitalize">
                {activeSubmission.browser_backend || "browser"}
              </Badge>
            </DialogTitle>
            <DialogDescription>
              Session {activeSubmission.browser_session_id}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {activeSubmission.browser_session_url && (
              <a
                href={activeSubmission.browser_session_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline inline-flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" /> Session
              </a>
            )}
            {liveViewUrl && (
              <a
                href={liveViewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline inline-flex items-center gap-1"
              >
                <Play className="h-3 w-3" /> Live View
              </a>
            )}
            {activeSubmission.recording_url && (
              <a
                href={activeSubmission.recording_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline inline-flex items-center gap-1"
              >
                <ExternalLink className="h-3 w-3" /> Recording
              </a>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="h-7 text-[11px]"
            >
              {isRefreshing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Refresh logs
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <div className="rounded border border-border/50 p-2">
              <div className="text-muted-foreground">Status</div>
              <div className="font-medium">{activeSubmission.browser_status || activeSubmission.status || "unknown"}</div>
            </div>
            <div className="rounded border border-border/50 p-2">
              <div className="text-muted-foreground">Region</div>
              <div className="font-medium">{activeSubmission.browser_region || "n/a"}</div>
            </div>
            <div className="rounded border border-border/50 p-2">
              <div className="text-muted-foreground">Logs synced</div>
              <div className="font-medium">{activeSubmission.browser_logs_synced_at ? formatDate(activeSubmission.browser_logs_synced_at) : "not yet"}</div>
            </div>
            <div className="rounded border border-border/50 p-2">
              <div className="text-muted-foreground">Events</div>
              <div className="font-medium">{data?.count ?? events.length}</div>
            </div>
          </div>

          <ScrollArea className="h-[420px] rounded border border-border/50">
            <div className="divide-y divide-border/50">
              {isLoading && (
                <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading session events...
                </div>
              )}
              {!isLoading && error && (
                <div className="p-4 text-sm text-red-400">
                  {error.message}
                </div>
              )}
              {!isLoading && !error && events.length === 0 && (
                <div className="p-4 text-sm text-muted-foreground">
                  No Browserbase session events have been synced yet.
                </div>
              )}
              {events.map((event) => (
                <div key={event.id} className="p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {event.method}
                    </Badge>
                    {event.level && (
                      <Badge variant="outline" className="capitalize text-[10px]">
                        {event.level}
                      </Badge>
                    )}
                    {event.status_code != null && (
                      <Badge variant="outline" className="text-[10px]">
                        {event.status_code}
                      </Badge>
                    )}
                    <span className="text-muted-foreground">
                      {event.occurred_at ? formatDate(event.occurred_at) : "Unknown time"}
                    </span>
                  </div>
                  {event.message && (
                    <div className="mt-2 whitespace-pre-wrap break-words text-sm">
                      {event.message}
                    </div>
                  )}
                  {event.url && (
                    <div className="mt-1 break-all text-muted-foreground">
                      {event.url}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PortalSubmissionCard({
  caseId,
  submission,
  onUpdated,
}: {
  caseId: string;
  submission: PortalSubmission;
  onUpdated: () => Promise<void> | void;
}) {
  const liveUrl = submission.browser_debugger_url || submission.browser_debugger_fullscreen_url || null;
  const needsAuthResume = String(submission.auth_intervention_status || "").toLowerCase() === "requested"
    || String(submission.status || "").toLowerCase() === "auth_intervention_required";
  const costPolicy = normalizeBrowserCostPolicy(submission.browser_cost_policy);
  const blockedTypes = Array.isArray(costPolicy.blockResourceTypes)
    ? costPolicy.blockResourceTypes.filter(Boolean).map((value) => String(value))
    : [];
  const captchaSolveEnabled = Boolean(costPolicy.solveCaptchas);
  const proxyPolicyActive = Boolean(costPolicy.proxies);
  const detailItems = [
    { label: "Engine", value: humanizePortalLabel(submission.engine, "Unknown") },
    { label: "Backend", value: humanizePortalLabel(submission.browser_backend, "Local browser") },
    { label: "Account", value: submission.account_email || "Not captured" },
    { label: "Region", value: humanizePortalLabel(submission.browser_region, "n/a") },
  ];
  const extractedInline = (() => {
    if (!submission.extracted_data || typeof submission.extracted_data !== "object") return null;
    const entries = Object.entries(submission.extracted_data).filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (entries.length === 0) return null;
    const filled = entries.length;
    const data = submission.extracted_data as Record<string, unknown>;
    const provider = data.provider || data.portal_provider || null;
    const pageKind = data.page_kind || data.page_type || null;
    const total = data.visible_fields || data.total_fields || null;
    const parts: string[] = [];
    if (total) {
      parts.push(`Filled ${filled}/${total} fields (${Math.round((filled / Number(total)) * 100)}%)`);
    } else {
      parts.push(`${filled} field${filled !== 1 ? "s" : ""} captured`);
    }
    if (provider) parts.push(String(provider));
    if (pageKind) parts.push(String(pageKind));
    return parts.join(" · ");
  })();

  return (
    <div className="rounded-2xl border border-border/60 bg-[linear-gradient(180deg,rgba(14,20,24,0.96),rgba(8,12,15,0.98))] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {portalStatusBadge(submission.status)}
            {isDryRunSubmission(submission) && (
              <Badge variant="outline" className="text-[10px] border-blue-500/30 bg-blue-500/10 text-blue-300">
                Dry Run
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {formatRelativeTime(submission.started_at)}
            </Badge>
          </div>
          <div className="mt-3 text-sm font-semibold text-foreground">
            {getPortalSubmissionHeadline(submission)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Started {formatDate(submission.started_at)}
            {submission.completed_at ? ` · Finished ${formatDate(submission.completed_at)}` : ""}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {submission.recording_url && (
            <a
              href={submission.recording_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 transition-colors hover:bg-cyan-500/20"
            >
              <Play className="h-3 w-3" />
              Recording
            </a>
          )}
          {submission.browser_session_url && (
            <a
              href={submission.browser_session_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-black/20 px-3 py-1.5 text-xs text-foreground/85 transition-colors hover:border-cyan-400/30 hover:text-cyan-200"
            >
              <Activity className="h-3 w-3" />
              Session
            </a>
          )}
          {liveUrl && (
            <a
              href={liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-black/20 px-3 py-1.5 text-xs text-foreground/85 transition-colors hover:border-cyan-400/30 hover:text-cyan-200"
            >
              <Play className="h-3 w-3" />
              Live
            </a>
          )}
          {submission.screenshot_url && (
            <a
              href={submission.screenshot_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-black/20 px-3 py-1.5 text-xs text-foreground/85 transition-colors hover:border-cyan-400/30 hover:text-cyan-200"
            >
              <ExternalLink className="h-3 w-3" />
              Screenshot
            </a>
          )}
          {submission.browser_session_id && (
            <BrowserbaseSessionDialog caseId={caseId} submission={submission} />
          )}
        </div>
      </div>

      {needsAuthResume && (
        <div className="mt-4 rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
                <UserCheck className="h-4 w-4" />
                Manual portal auth required
              </div>
              <div className="mt-1 text-xs text-cyan-50/80">
                {submission.auth_intervention_reason || "Complete the portal login or 2FA step in Browserbase, then resume the same submission."}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-cyan-50/70">
                {submission.auth_context_id && (
                  <span className="rounded-full border border-cyan-400/20 bg-black/20 px-2 py-1">
                    Context {submission.auth_context_id}
                  </span>
                )}
                {submission.auth_intervention_requested_at && (
                  <span className="rounded-full border border-cyan-400/20 bg-black/20 px-2 py-1">
                    Requested {formatDate(submission.auth_intervention_requested_at)}
                  </span>
                )}
                {submission.browser_keep_alive && (
                  <span className="rounded-full border border-cyan-400/20 bg-black/20 px-2 py-1">
                    Session kept alive
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {liveUrl && (
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-black/20 px-3 py-1.5 text-xs text-cyan-100 transition-colors hover:border-cyan-300/50 hover:text-white"
                >
                  <Play className="h-3 w-3" />
                  Open Live View
                </a>
              )}
              <PortalAuthResumeButton caseId={caseId} submission={submission} onCompleted={onUpdated} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {detailItems.map((item) => (
          <div key={item.label} className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{item.label}</div>
            <div className="mt-1 truncate text-sm font-medium text-foreground/90" title={item.value}>
              {item.value}
            </div>
          </div>
        ))}
      </div>

      {(submission.auth_context_id || submission.browser_keep_alive || blockedTypes.length > 0 || proxyPolicyActive || captchaSolveEnabled) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {submission.auth_context_id && (
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-foreground/80">
              Auth context enabled
            </div>
          )}
          {submission.browser_keep_alive && (
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-foreground/80">
              Keep alive
            </div>
          )}
          {captchaSolveEnabled && (
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-foreground/80">
              CAPTCHA solve on
            </div>
          )}
          {proxyPolicyActive && (
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-foreground/80">
              Proxy policy active
            </div>
          )}
          {blockedTypes.length > 0 && (
            <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-foreground/80">
              Blocked assets: {blockedTypes.join(", ")}
            </div>
          )}
        </div>
      )}

      {submission.error_message && (
        <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3" />
            Run issue
          </div>
          <div className="whitespace-pre-wrap break-words">{submission.error_message}</div>
        </div>
      )}

      {extractedInline && (
        <div className="mt-4 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] text-emerald-200 w-fit">
          {extractedInline}
        </div>
      )}

      {submission.screenshot_url && (
        <div className="mt-4">
          <PortalSubmissionScreenshot
            url={submission.screenshot_url}
            alt={`Portal screenshot for submission ${submission.id}`}
          />
        </div>
      )}
    </div>
  );
}

function PortalSubmissionsSection({ caseId }: { caseId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [submissions, setSubmissions] = useState<PortalSubmission[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSubmissions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetcher<{ success: boolean; count: number; submissions: PortalSubmission[] }>(
        `/requests/${caseId}/portal-submissions`
      );
      setSubmissions(data.submissions || []);
      setHasLoaded(true);
    } catch (err: any) {
      setError(err?.message || "Failed to load portal submissions");
    } finally {
      setIsLoading(false);
    }
  }, [caseId]);

  const handleToggle = async () => {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen && !hasLoaded) {
      await loadSubmissions();
    }
  };

  return (
    <details open={isOpen || undefined} className="border-b border-border/50 group" onToggle={(e) => {
      const open = (e.target as HTMLDetailsElement).open;
      if (open && !isOpen) handleToggle();
      else if (!open && isOpen) setIsOpen(false);
    }}>
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 shrink-0" />
        Portal Activity
        {hasLoaded && <span className="ml-auto text-muted-foreground">{submissions.length}</span>}
      </summary>
      <div className="px-3 pb-2">
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading submissions...
          </div>
        )}
        {error && (
          <div className="text-[10px] text-red-400 py-2">{error}</div>
        )}
        {hasLoaded && submissions.length === 0 && !isLoading && (
          <div className="text-[10px] text-muted-foreground py-2">No portal submissions recorded</div>
        )}
        {hasLoaded && submissions.length > 0 && (
          <div className="space-y-3">
            {submissions.map((sub) => (
              <PortalSubmissionCard key={sub.id} caseId={caseId} submission={sub} onUpdated={loadSubmissions} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

// ── Provider Payloads Section ─────────────────────────────────────────────

interface ProviderPayloadMessage {
  id: number;
  direction: string;
  message_type: string | null;
  subject: string | null;
  from_email: string | null;
  to_email: string | null;
  provider_payload: Record<string, unknown> | null;
  created_at: string;
  delivered_at: string | null;
  bounced_at: string | null;
  sendgrid_message_id: string | null;
}

interface ProviderPayloadExecution {
  id: number;
  proposal_id: number | null;
  action_type: string;
  status: string;
  provider: string | null;
  provider_payload: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
  provider_message_id: string | null;
  failure_stage: string | null;
  failure_code: string | null;
}

interface ProviderPayloadEmailEvent {
  id: number;
  event_type: string;
  provider_message_id: string | null;
  raw_payload: Record<string, unknown> | null;
  event_timestamp: string;
}

interface ProviderPayloadsResponse {
  success: boolean;
  case_id: number;
  messages: ProviderPayloadMessage[];
  executions: ProviderPayloadExecution[];
  email_events: ProviderPayloadEmailEvent[];
  summary: {
    message_payload_count: number;
    execution_payload_count: number;
    email_event_count: number;
  };
}

function directionBadge(direction: string) {
  if (direction === "inbound")
    return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-[10px] px-1 py-0">IN</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] px-1 py-0">OUT</Badge>;
}

function ExpandablePayloadRow({ children, payload }: { children: React.ReactNode; payload: Record<string, unknown> | null }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <TableRow
        className="hover:bg-muted/30 cursor-pointer"
        onClick={() => payload && setExpanded(!expanded)}
      >
        {children}
      </TableRow>
      {expanded && payload && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={99} className="p-0">
            <pre className="text-[10px] bg-muted/30 p-2 overflow-x-auto max-h-[300px] overflow-y-auto font-mono whitespace-pre-wrap break-all border-t border-border/30">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ProviderPayloadsSection({ caseId }: { caseId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [data, setData] = useState<ProviderPayloadsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen && !hasLoaded) {
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetcher<ProviderPayloadsResponse>(
          `/requests/${caseId}/provider-payloads`
        );
        setData(result);
        setHasLoaded(true);
      } catch (err: any) {
        setError(err?.message || "Failed to load provider payloads");
      } finally {
        setIsLoading(false);
      }
    }
  };

  const msgCount = data?.summary?.message_payload_count ?? 0;
  const execCount = data?.summary?.execution_payload_count ?? 0;
  const eventCount = data?.summary?.email_event_count ?? 0;

  return (
    <details open={isOpen || undefined} className="border-b border-border/50 group" onToggle={(e) => {
      const open = (e.target as HTMLDetailsElement).open;
      if (open && !isOpen) handleToggle();
      else if (!open && isOpen) setIsOpen(false);
    }}>
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 shrink-0" />
        Provider Payloads
        {hasLoaded && (
          <span className="ml-auto text-muted-foreground">
            {msgCount} msg, {execCount} exec{eventCount > 0 ? `, ${eventCount} events` : ""}
          </span>
        )}
      </summary>
      <div className="px-3 pb-2">
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading provider payloads...
          </div>
        )}
        {error && (
          <div className="text-[10px] text-red-400 py-2">{error}</div>
        )}
        {hasLoaded && msgCount === 0 && execCount === 0 && !isLoading && (
          <div className="text-[10px] text-muted-foreground py-2">No provider payloads recorded</div>
        )}

        {/* Messages sub-section */}
        {hasLoaded && data && data.messages.length > 0 && (
          <div className="mb-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Messages</div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[10px] h-6 px-1">Dir</TableHead>
                  <TableHead className="text-[10px] h-6 px-1">Subject</TableHead>
                  <TableHead className="text-[10px] h-6 px-1">From / To</TableHead>
                  <TableHead className="text-[10px] h-6 px-1">Delivery</TableHead>
                  <TableHead className="text-[10px] h-6 px-1 text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.messages.map((msg) => (
                  <ExpandablePayloadRow key={msg.id} payload={msg.provider_payload}>
                    <TableCell className="text-[10px] px-1 py-1">
                      {directionBadge(msg.direction)}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 max-w-[140px] truncate" title={msg.subject || undefined}>
                      {msg.subject || "\u2014"}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 text-muted-foreground max-w-[120px] truncate" title={`${msg.from_email || ""} \u2192 ${msg.to_email || ""}`}>
                      {msg.from_email ? msg.from_email.split("@")[0] : "\u2014"} {"\u2192"} {msg.to_email ? msg.to_email.split("@")[0] : "\u2014"}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1">
                      {msg.bounced_at ? (
                        <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px] px-1 py-0">bounced</Badge>
                      ) : msg.delivered_at ? (
                        <Badge className="bg-green-500/15 text-green-400 border-green-500/30 text-[10px] px-1 py-0">delivered</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">pending</Badge>
                      )}
                      {msg.provider_payload && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 ml-1">payload</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 text-muted-foreground text-right whitespace-nowrap">
                      {formatRelativeTime(msg.created_at)}
                    </TableCell>
                  </ExpandablePayloadRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Executions sub-section */}
        {hasLoaded && data && data.executions.length > 0 && (
          <div className="mb-3">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Executions</div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[10px] h-6 px-1">Action</TableHead>
                  <TableHead className="text-[10px] h-6 px-1">Status</TableHead>
                  <TableHead className="text-[10px] h-6 px-1">Provider</TableHead>
                  <TableHead className="text-[10px] h-6 px-1">Msg ID</TableHead>
                  <TableHead className="text-[10px] h-6 px-1 text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.executions.map((exec) => (
                  <ExpandablePayloadRow key={exec.id} payload={exec.provider_payload}>
                    <TableCell className="text-[10px] px-1 py-1 font-mono">
                      {exec.action_type}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1">
                      {portalStatusBadge(exec.status)}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 text-muted-foreground">
                      {exec.provider || "\u2014"}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 text-muted-foreground font-mono max-w-[100px] truncate" title={exec.provider_message_id || undefined}>
                      {exec.provider_message_id ? exec.provider_message_id.slice(0, 12) + "\u2026" : "\u2014"}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 text-muted-foreground text-right whitespace-nowrap">
                      {formatRelativeTime(exec.created_at)}
                    </TableCell>
                  </ExpandablePayloadRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Email Events sub-section */}
        {hasLoaded && data && data.email_events.length > 0 && (
          <div>
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Email Events</div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-[10px] h-6 px-1">Event</TableHead>
                  <TableHead className="text-[10px] h-6 px-1">Provider Msg ID</TableHead>
                  <TableHead className="text-[10px] h-6 px-1 text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.email_events.map((evt) => (
                  <ExpandablePayloadRow key={evt.id} payload={evt.raw_payload}>
                    <TableCell className="text-[10px] px-1 py-1">
                      <Badge variant="outline" className="text-[10px] px-1 py-0">{evt.event_type}</Badge>
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 text-muted-foreground font-mono max-w-[120px] truncate" title={evt.provider_message_id || undefined}>
                      {evt.provider_message_id || "\u2014"}
                    </TableCell>
                    <TableCell className="text-[10px] px-1 py-1 text-muted-foreground text-right whitespace-nowrap">
                      {formatRelativeTime(evt.event_timestamp)}
                    </TableCell>
                  </ExpandablePayloadRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </details>
  );
}

// ── Proposal History Section ─────────────────────────────────────────────────

interface AgentLogEntry {
  id: string;
  timestamp: string;
  kind: string;
  source: string;
  title: string;
  summary: string;
  severity: string;
  run_id: number | null;
  message_id: number | null;
  proposal_id: number | null;
  step: string | null;
  payload: Record<string, unknown> | null;
}

interface AgentLogResponse {
  success: boolean;
  case_id: number;
  count: number;
  summary: {
    total: number;
    by_source: Record<string, number>;
    by_kind: Record<string, number>;
    by_severity: Record<string, number>;
  };
  entries: AgentLogEntry[];
}

function agentLogKindBadge(kind: string, severity?: string) {
  const normalized = String(kind || '').toLowerCase();
  const cls = severity === 'error'
    ? 'bg-red-500/15 text-red-400 border-red-500/30'
    : severity === 'warning'
      ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
      : normalized === 'decision'
        ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
        : normalized === 'portal'
          ? 'bg-purple-500/15 text-purple-400 border-purple-500/30'
          : normalized === 'provider_event'
            ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
            : normalized === 'agent_step'
              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
              : 'border-border/50 text-muted-foreground';
  return <Badge className={cn('text-[10px] px-1 py-0', cls)}>{kind.replace(/_/g, ' ')}</Badge>;
}

function AgentLogSection({ caseId, compact = false }: { caseId: string; compact?: boolean }) {
  const [isOpen, setIsOpen] = useState(compact);
  const [entries, setEntries] = useState<AgentLogEntry[]>([]);
  const [summary, setSummary] = useState<AgentLogResponse['summary'] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoad = async () => {
    if (hasLoaded || isLoading) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetcher<AgentLogResponse>(`/requests/${caseId}/agent-log?limit=${compact ? 20 : 50}`);
      setEntries(data.entries || []);
      setSummary(data.summary || null);
      setHasLoaded(true);
    } catch (err: any) {
      setError(err?.message || 'Failed to load agent log');
    } finally {
      setIsLoading(false);
    }
  };

  if (compact) {
    return (
      <div className='space-y-1'>
        {!hasLoaded && !isLoading && (
          <Button size='sm' variant='outline' className='text-[10px]' onClick={handleLoad}>Load Agent Log</Button>
        )}
        {isLoading && <div className='flex items-center gap-2 py-2 text-[10px] text-muted-foreground'><Loader2 className='h-3 w-3 animate-spin' /> Loading agent log...</div>}
        {error && <div className='text-[10px] text-red-400 py-1'>{error}</div>}
        {hasLoaded && entries.length === 0 && !isLoading && <p className='text-xs text-muted-foreground'>No agent log entries yet</p>}
        {entries.slice(0, 20).map((entry) => (
          <div key={entry.id} className='rounded border border-border/40 p-2 text-[11px] space-y-1'>
            <div className='flex items-center gap-2'>
              <span className='text-muted-foreground shrink-0'>{formatRelativeTime(entry.timestamp)}</span>
              {agentLogKindBadge(entry.kind, entry.severity)}
              {entry.step && <Badge variant='outline' className='text-[10px] px-1 py-0'>{entry.step}</Badge>}
            </div>
            <div className='font-medium'>{entry.title}</div>
            <div className='text-muted-foreground break-words'>{entry.summary}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <details open={isOpen || undefined} className='border-b border-border/50 group' onToggle={(e) => {
      const open = (e.target as HTMLDetailsElement).open;
      setIsOpen(open);
      if (open) handleLoad();
    }}>
      <summary className='px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden'>
        <ChevronRight className='h-3 w-3 transition-transform group-open:rotate-90 shrink-0' />
        Agent Log
        {hasLoaded && <span className='ml-auto text-muted-foreground'>{summary?.total ?? entries.length}</span>}
      </summary>
      <div className='px-3 pb-2'>
        {isLoading && <div className='flex items-center gap-2 py-3 text-[10px] text-muted-foreground'><Loader2 className='h-3 w-3 animate-spin' /> Loading agent log...</div>}
        {error && <div className='text-[10px] text-red-400 py-2'>{error}</div>}
        {hasLoaded && entries.length === 0 && !isLoading && <div className='text-[10px] text-muted-foreground py-2'>No agent log entries recorded</div>}
        {hasLoaded && entries.length > 0 && (
          <div className='space-y-1.5'>
            {entries.map((entry) => (
              <div key={entry.id} className='border border-border/50 rounded-md p-2 text-[10px] space-y-1'>
                <div className='flex items-center gap-2 flex-wrap'>
                  {agentLogKindBadge(entry.kind, entry.severity)}
                  {entry.step && <Badge variant='outline' className='text-[10px] px-1 py-0'>{entry.step}</Badge>}
                  {entry.run_id && <Badge variant='outline' className='text-[10px] px-1 py-0'>run {entry.run_id}</Badge>}
                  <span className='ml-auto text-muted-foreground'>{formatRelativeTime(entry.timestamp)}</span>
                </div>
                <div className='font-medium'>{entry.title}</div>
                <div className='text-muted-foreground whitespace-pre-wrap break-words'>{entry.summary}</div>
                {entry.payload && (
                  <details>
                    <summary className='cursor-pointer text-muted-foreground hover:text-foreground'>Details</summary>
                    <pre className='mt-1 text-[10px] bg-muted/30 p-2 overflow-x-auto max-h-[240px] overflow-y-auto font-mono whitespace-pre-wrap break-all border border-border/30 rounded'>
                      {JSON.stringify(entry.payload, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

interface ProposalHistoryItem {
  id: number;
  action_type: string;
  status: string;
  draft_subject: string | null;
  draft_preview: string | null;
  reasoning: string[] | null;
  confidence: number | null;
  human_decision: Record<string, unknown> | null;
  human_decided_by: string | null;
  human_decided_at: string | null;
  human_edited: boolean;
  original_draft_subject: string | null;
  original_draft_body_text: string | null;
  executed_at: string | null;
  created_at: string;
}

function proposalStatusBadge(status: string) {
  const s = status.toUpperCase();
  if (s === "EXECUTED") return <Badge className="bg-green-500/15 text-green-400 border-green-500/30 text-[10px] px-1 py-0">{status}</Badge>;
  if (s === "DISMISSED" || s === "WITHDRAWN") return <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px] px-1 py-0">{status}</Badge>;
  if (s.includes("PENDING") || s === "BLOCKED") return <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-[10px] px-1 py-0">{status}</Badge>;
  return <Badge variant="outline" className="text-[10px] px-1 py-0">{status}</Badge>;
}

function ProposalHistorySection({ caseId }: { caseId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [proposals, setProposals] = useState<ProposalHistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const handleToggle = async () => {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen && !hasLoaded) {
      setIsLoading(true);
      setError(null);
      try {
        const data = await fetcher<{ success: boolean; count: number; proposals: ProposalHistoryItem[] }>(
          `/requests/${caseId}/proposals?all=true&limit=50`
        );
        setProposals(data.proposals || []);
        setHasLoaded(true);
      } catch (err: any) {
        setError(err?.message || "Failed to load proposals");
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <details open={isOpen || undefined} className="border-b border-border/50 group" onToggle={(e) => {
      const open = (e.target as HTMLDetailsElement).open;
      if (open && !isOpen) handleToggle();
      else if (!open && isOpen) setIsOpen(false);
    }}>
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 shrink-0" />
        Proposal History
        {hasLoaded && <span className="ml-auto text-muted-foreground">{proposals.length}</span>}
      </summary>
      <div className="px-3 pb-2">
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading proposals...
          </div>
        )}
        {error && <div className="text-[10px] text-red-400 py-2">{error}</div>}
        {hasLoaded && proposals.length === 0 && !isLoading && (
          <div className="text-[10px] text-muted-foreground py-2">No proposals recorded</div>
        )}
        {hasLoaded && proposals.length > 0 && (
          <div className="space-y-1.5">
            {proposals.map((p) => (
              <div key={p.id} className="border border-border/50 rounded-md text-[10px]">
                <button
                  className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-muted/30 transition-colors text-left"
                  onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                >
                  <ChevronRight className={cn("h-2.5 w-2.5 shrink-0 transition-transform", expandedId === p.id && "rotate-90")} />
                  <Badge variant="outline" className={cn("text-[10px] px-1 py-0 shrink-0", ACTION_TYPE_LABELS[p.action_type]?.color || "")}>
                    {ACTION_TYPE_LABELS[p.action_type]?.label || p.action_type.replace(/_/g, " ")}
                  </Badge>
                  {proposalStatusBadge(p.status)}
                  {p.human_edited && (
                    <Badge className="bg-purple-500/15 text-purple-400 border-purple-500/30 text-[10px] px-1 py-0">Edited</Badge>
                  )}
                  {p.draft_subject && (
                    <span className="text-muted-foreground truncate min-w-0">{p.draft_subject}</span>
                  )}
                  <span className="ml-auto text-muted-foreground shrink-0">{formatRelativeTime(p.created_at)}</span>
                </button>
                {expandedId === p.id && (
                  <div className="px-2 pb-2 space-y-1.5 border-t border-border/30">
                    {/* Decision audit */}
                    {p.human_decided_by && (
                      <div className="flex items-center gap-2 pt-1.5">
                        <UserCheck className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Decided by</span>
                        <span className="text-foreground font-medium">{p.human_decided_by}</span>
                        {p.human_decided_at && (
                          <span className="text-muted-foreground">{formatRelativeTime(p.human_decided_at)}</span>
                        )}
                      </div>
                    )}

                    {/* Human decision details */}
                    {p.human_decision && (
                      <div className="text-muted-foreground">
                        Decision: {typeof p.human_decision === "object"
                          ? (p.human_decision as any).action || JSON.stringify(p.human_decision)
                          : String(p.human_decision)}
                      </div>
                    )}

                    {/* Reasoning */}
                    {Array.isArray(p.reasoning) && p.reasoning.length > 0 && (
                      <div>
                        <div className="text-muted-foreground font-medium mb-0.5">Reasoning:</div>
                        <ul className="space-y-0.5 text-muted-foreground">
                          {p.reasoning.slice(0, 3).map((r, i) => (
                            <li key={i} className="flex gap-1"><span className="text-blue-400 shrink-0">-</span><span>{r}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Original vs edited draft comparison */}
                    {p.human_edited && p.original_draft_body_text && (
                      <details className="mt-1">
                        <summary className="text-muted-foreground cursor-pointer hover:text-foreground">Original AI Draft (before edit)</summary>
                        <div className="mt-1 p-2 bg-muted/20 rounded border border-border/30 space-y-1">
                          {p.original_draft_subject && (
                            <div><span className="text-muted-foreground">Subject:</span> {p.original_draft_subject}</div>
                          )}
                          <div className="whitespace-pre-wrap text-muted-foreground max-h-[200px] overflow-y-auto">
                            {p.original_draft_body_text}
                          </div>
                        </div>
                      </details>
                    )}

                    {/* Current draft preview */}
                    {p.draft_preview && (
                      <div className="text-muted-foreground whitespace-pre-wrap max-h-[100px] overflow-y-auto">
                        {p.draft_preview}
                      </div>
                    )}

                    {/* Timestamps */}
                    <div className="flex gap-4 text-muted-foreground pt-1">
                      <span>Created: {formatDate(p.created_at)}</span>
                      {p.executed_at && <span>Executed: {formatDate(p.executed_at)}</span>}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

// ── Decision Traces Section ──────────────────────────────────────────────────

interface DecisionTrace {
  id: number;
  run_id: number | null;
  classification: {
    intent?: string;
    confidence?: number;
    sentiment?: string;
    fee_amount?: number | null;
    key_points?: string[];
  } | null;
  router_output: {
    action_type?: string;
    can_auto_execute?: boolean;
    requires_human?: boolean;
    pause_reason?: string | null;
  } | null;
  node_trace: string[] | null;
  gate_decision: {
    gated?: boolean;
    pause_reason?: string | null;
  } | null;
  duration_ms: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

function DecisionTracesSection({ caseId }: { caseId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [traces, setTraces] = useState<DecisionTrace[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async () => {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen && !hasLoaded) {
      setIsLoading(true);
      setError(null);
      try {
        const data = await fetcher<{ success: boolean; count: number; entries: Array<{ source: string; payload: DecisionTrace }> }>(
          `/requests/${caseId}/audit-stream?source=decision_traces&limit=20`
        );
        setTraces((data.entries || []).map(e => e.payload));
        setHasLoaded(true);
      } catch (err: any) {
        setError(err?.message || "Failed to load decision traces");
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <details open={isOpen || undefined} className="border-b border-border/50 group" onToggle={(e) => {
      const open = (e.target as HTMLDetailsElement).open;
      if (open && !isOpen) handleToggle();
      else if (!open && isOpen) setIsOpen(false);
    }}>
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 shrink-0" />
        Decision Traces
        {hasLoaded && <span className="ml-auto text-muted-foreground">{traces.length}</span>}
      </summary>
      <div className="px-3 pb-2">
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading traces...
          </div>
        )}
        {error && <div className="text-[10px] text-red-400 py-2">{error}</div>}
        {hasLoaded && traces.length === 0 && !isLoading && (
          <div className="text-[10px] text-muted-foreground py-2">No decision traces recorded</div>
        )}
        {hasLoaded && traces.length > 0 && (
          <div className="space-y-2">
            {traces.map((trace) => (
              <div key={trace.id} className="border border-border/50 rounded-md p-2 space-y-1.5 text-[10px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {trace.classification?.intent && (
                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                        {trace.classification.intent}
                      </Badge>
                    )}
                    {trace.classification?.confidence != null && (
                      <span className={cn(
                        "font-mono",
                        trace.classification.confidence >= 0.8 ? "text-green-400" :
                        trace.classification.confidence >= 0.5 ? "text-yellow-400" : "text-red-400"
                      )}>
                        {Math.round(trace.classification.confidence * 100)}%
                      </span>
                    )}
                    {trace.router_output?.action_type && (
                      <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30 text-[10px] px-1 py-0">
                        {trace.router_output.action_type}
                      </Badge>
                    )}
                    {trace.router_output?.can_auto_execute && (
                      <Badge className="bg-green-500/15 text-green-400 border-green-500/30 text-[10px] px-1 py-0">AUTO</Badge>
                    )}
                    {trace.gate_decision?.gated && (
                      <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-[10px] px-1 py-0">GATED</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground shrink-0">
                    {trace.duration_ms != null && <span>{trace.duration_ms}ms</span>}
                    <span>{formatRelativeTime(trace.created_at)}</span>
                  </div>
                </div>

                {/* Node trace flow */}
                {trace.node_trace && trace.node_trace.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap text-muted-foreground">
                    {trace.node_trace.map((node, i) => (
                      <span key={i} className="flex items-center gap-1">
                        <span className="font-mono text-foreground/80">{node}</span>
                        {i < trace.node_trace!.length - 1 && <ArrowRight className="h-2.5 w-2.5" />}
                      </span>
                    ))}
                  </div>
                )}

                {/* Key points / classification details */}
                {trace.classification?.key_points && trace.classification.key_points.length > 0 && (
                  <div className="text-muted-foreground">
                    {trace.classification.key_points.slice(0, 3).join(" | ")}
                  </div>
                )}

                {/* Pause reason */}
                {(trace.router_output?.pause_reason || trace.gate_decision?.pause_reason) && (
                  <div className="text-yellow-400/80">
                    Pause: {trace.router_output?.pause_reason || trace.gate_decision?.pause_reason}
                  </div>
                )}

                {/* Run link */}
                {trace.run_id && (
                  <div className="text-muted-foreground">
                    Run: <Link href={`/runs?run=${trace.run_id}`} className="text-blue-400 hover:underline font-mono">
                      #{trace.run_id}
                    </Link>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

function DetailV2Content() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const id = searchParams.get("id");

  // ── State ──────────────────────────────────────────────────────────────────
  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [snoozeModalOpen, setSnoozeModalOpen] = useState(false);
  const [proposalState, setProposalState] = useState<ProposalState>("PENDING");
  const [isApproving, setIsApproving] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  const [bugDialogOpen, setBugDialogOpen] = useState(false);
  const [bugDescription, setBugDescription] = useState("");
  const [scheduledSendAt, setScheduledSendAt] = useState<string | null>(null);
  const [draftStates, setDraftStates] = useState<Map<number, DraftState>>(new Map());
  const getDraft = useCallback((proposalId: number): DraftState => {
    return draftStates.get(proposalId) || { editedBody: "", editedSubject: "", editedRecipient: "", editedChainSubject: "", editedChainBody: "", proposalAttachments: [] };
  }, [draftStates]);
  const setDraft = useCallback((proposalId: number, updates: Partial<DraftState>) => {
    setDraftStates(prev => {
      const next = new Map(prev);
      const current = prev.get(proposalId) || { editedBody: "", editedSubject: "", editedRecipient: "", editedChainSubject: "", editedChainBody: "", proposalAttachments: [] };
      next.set(proposalId, { ...current, ...updates });
      return next;
    });
  }, []);
  const [pendingAdjustModalOpen, setPendingAdjustModalOpen] = useState(false);
  const [pendingAdjustProposalId, setPendingAdjustProposalId] = useState<number | null>(null);
  const [isAdjustingPending, setIsAdjustingPending] = useState(false);
  const [manualSubmitOpen, setManualSubmitOpen] = useState(false);
  const [isManualSubmitting, setIsManualSubmitting] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [guideModalOpen, setGuideModalOpen] = useState(false);
  const [isGuidingAI, setIsGuidingAI] = useState(false);
  const [isRevising, setIsRevising] = useState(false);
  const [isInvokingAgent, setIsInvokingAgent] = useState(false);
  const [isGeneratingInitial, setIsGeneratingInitial] = useState(false);
  const [isRunningFollowup, setIsRunningFollowup] = useState(false);
  const [isResettingCase, setIsResettingCase] = useState(false);
  const [showPasteInboundDialog, setShowPasteInboundDialog] = useState(false);
  const [showCorrespondenceDialog, setShowCorrespondenceDialog] = useState(false);
  const [showInboundDialog, setShowInboundDialog] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [isRunningInbound, setIsRunningInbound] = useState(false);
  const [optimisticMessages, setOptimisticMessages] = useState<Array<ThreadMessage & { _sending: true }>>([]);
  const [pendingSubmission, setPendingSubmission] = useState<{ proposalId: number; startedAt: number } | null>(null);
  const [pendingUiLockUntil, setPendingUiLockUntil] = useState<number>(0);
  // Chain draft editing is now part of DraftState (draftStates map)
  // Constraint management
  const [constraintEditing, setConstraintEditing] = useState(false);
  const [addConstraintOpen, setAddConstraintOpen] = useState(false);
  const [newConstraintType, setNewConstraintType] = useState("FEE_REQUIRED");
  const [newConstraintDesc, setNewConstraintDesc] = useState("");
  // Tags
  const [tagInput, setTagInput] = useState("");
  const [tagSaving, setTagSaving] = useState(false);
  // View management
  const [activeView, setActiveView] = useState<"thread" | "case-info" | "agency" | "intel" | "timeline">("thread");
  const [bottomDrawer, setBottomDrawer] = useState<"runs" | "agent-log" | null>(null);
  const [conversationTab, setConversationTab] = useState<string>("all");
  // Multi-agency state
  const [agencyActionLoading, setAgencyActionLoading] = useState<{
    id: number;
    action: "primary" | "research" | "confirm-portal" | "validate-portal" | "block-portal";
  } | null>(null);
  const [agencyStartLoadingId, setAgencyStartLoadingId] = useState<number | null>(null);
  const [candidateActionLoadingName, setCandidateActionLoadingName] = useState<string | null>(null);
  const [candidateStartLoadingName, setCandidateStartLoadingName] = useState<string | null>(null);
  const [manualAgencyName, setManualAgencyName] = useState("");
  const [manualAgencyEmail, setManualAgencyEmail] = useState("");
  const [manualAgencyPortalUrl, setManualAgencyPortalUrl] = useState("");
  const [isManualAgencySubmitting, setIsManualAgencySubmitting] = useState(false);
  const [editingAgencyId, setEditingAgencyId] = useState<number | null>(null);
  const [editAgencyFields, setEditAgencyFields] = useState<Record<string, string | null>>({});
  // Resizable sidebar
  const SIDEBAR_STORAGE_KEY = "detail-v2-sidebar-width";
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored) return Math.max(280, Math.min(700, parseInt(stored, 10)));
    }
    return 380;
  });
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(380);

  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = dragStartXRef.current - ev.clientX; // dragging left = wider sidebar
      const newWidth = Math.max(280, Math.min(700, dragStartWidthRef.current + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Persist
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(w));
        return w;
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [sidebarWidth]);

  // ── Polling ────────────────────────────────────────────────────────────────
  const [pollingUntil, setPollingUntil] = useState<number>(0);
  const refreshInterval = Date.now() < pollingUntil ? 3000 : 0;

  const { data, error, isLoading, mutate } = useSWR<RequestWorkspaceResponse>(
    id ? `/requests/${id}/workspace` : null,
    fetcher,
    { refreshInterval, keepPreviousData: true }
  );

  useEffect(() => {
    setNextAction(data?.next_action_proposal || null);
  }, [data?.next_action_proposal]);

  const originalRecipient = data?.request?.agency_email || "";

  const lastInboundMessage = useMemo(() => {
    if (!data?.thread_messages) return null;
    const inbound = data.thread_messages.filter(m => m.direction === "INBOUND");
    return inbound.length > 0 ? inbound[inbound.length - 1] : null;
  }, [data?.thread_messages]);

  const { data: runsData, mutate: mutateRuns } = useSWR<{ runs: AgentRun[] }>(
    id ? `/requests/${id}/agent-runs` : null,
    fetcher,
    { refreshInterval, keepPreviousData: true }
  );

  const startPolling = useCallback(() => {
    setPollingUntil(Date.now() + 30_000);
  }, []);

  const optimisticClear = useCallback((clearedProposalId?: number) => {
    mutate(
      (cur) => {
        if (!cur) return cur;
        // Resolve current proposals from data
        const currentProposals: PendingProposal[] = (cur as any).pending_proposals?.length > 0
          ? (cur as any).pending_proposals
          : cur.pending_proposal ? [cur.pending_proposal] : [];
        const remainingProposals = clearedProposalId != null
          ? currentProposals.filter(p => p.id !== clearedProposalId)
          : [];
        const noProposalsLeft = remainingProposals.length === 0;
        return {
          ...cur,
          request: noProposalsLeft
            ? { ...cur.request, requires_human: false, pause_reason: null, status: 'AWAITING_RESPONSE' as const }
            : cur.request,
          pending_proposal: remainingProposals.length > 0 ? remainingProposals[0] : null,
          pending_proposals: remainingProposals,
          next_action_proposal: noProposalsLeft ? null : cur.next_action_proposal,
          review_state: noProposalsLeft ? 'PROCESSING' : cur.review_state,
          control_state: noProposalsLeft ? 'WORKING' : cur.control_state,
        };
      },
      { revalidate: true }
    );
    mutateRuns();
    startPolling();
  }, [mutate, mutateRuns, startPolling]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const _threadMessages = data?.thread_messages || [];
  const _caseAgencies: CaseAgency[] = (data as any)?.case_agencies || [];
  const _activeCaseAgencies = _caseAgencies.filter((ca: CaseAgency) => ca.is_active !== false);

  const _pendingProposals: PendingProposal[] = useMemo(() => {
    const plural = (data as any)?.pending_proposals as PendingProposal[] | undefined;
    if (plural && plural.length > 0) return plural;
    if (data?.pending_proposal) return [data.pending_proposal];
    return [];
  }, [data]);

  const proposalsByAgencyBucket = useMemo(() => {
    const map = new Map<string, PendingProposal[]>();
    for (const p of _pendingProposals) {
      const key = p.case_agency_id != null ? `agency-${p.case_agency_id}` : "unscoped";
      const arr = map.get(key) || [];
      arr.push(p);
      map.set(key, arr);
    }
    return map;
  }, [_pendingProposals]);

  // Initialize draft state for each pending proposal
  useEffect(() => {
    setDraftStates(prev => {
      const next = new Map(prev);
      const activeIds = new Set<number>();
      for (const p of _pendingProposals) {
        activeIds.add(p.id);
        if (next.has(p.id)) continue; // preserve user edits
        let recipient = originalRecipient;
        if (p.case_agency_id != null) {
          const ag = _caseAgencies.find(ca => ca.id === p.case_agency_id);
          if (ag?.agency_email) recipient = ag.agency_email;
        }
        const chain = p.action_chain;
        next.set(p.id, {
          editedBody: p.draft_body_text || "",
          editedSubject: p.draft_subject || "",
          editedRecipient: recipient,
          editedChainSubject: chain && chain.length > 1 ? (chain[1].draftSubject || "") : "",
          editedChainBody: chain && chain.length > 1 ? (chain[1].draftBodyText || "") : "",
          proposalAttachments: [],
        });
      }
      for (const key of next.keys()) {
        if (!activeIds.has(key)) next.delete(key);
      }
      return next;
    });
  }, [_pendingProposals, originalRecipient, _caseAgencies]);

  const conversationAgencies = useMemo(() => {
    const dedup = new Map<string, CaseAgency>();
    for (const agency of _activeCaseAgencies) {
      const key = `${String(agency.agency_name || "").trim().toLowerCase()}|${String(agency.agency_email || "").trim().toLowerCase()}|${String(agency.portal_url || "").trim().toLowerCase()}`;
      const existing = dedup.get(key);
      if (!existing) {
        dedup.set(key, agency);
        continue;
      }
      if (!existing.is_primary && agency.is_primary) {
        dedup.set(key, agency);
      }
    }
    return Array.from(dedup.values());
  }, [_activeCaseAgencies]);
  const distinctProposalAgencies = useMemo(() => {
    const ids = new Set(_pendingProposals.map(p => p.case_agency_id).filter(id => id != null));
    return ids.size;
  }, [_pendingProposals]);
  const shouldShowConversationTabs = conversationAgencies.length > 1 || distinctProposalAgencies >= 2;

  const conversationBuckets = useMemo(() => {
    const allIds = new Set(_threadMessages.map((m) => m.id));
    const buckets: Array<{ id: string; label: string; count: number; messageIds: Set<number>; proposals: PendingProposal[] }> = [
      { id: "all", label: "All", count: _threadMessages.length, messageIds: allIds, proposals: _pendingProposals },
    ];
    if (!shouldShowConversationTabs) return buckets;

    // Priority-based exclusive assignment so messages aren't duplicated across tabs
    const assigned = new Map<number, string>(); // messageId → bucketId

    // Pass 1: explicit case_agency_id (highest priority)
    for (const msg of _threadMessages) {
      if (msg.case_agency_id != null) {
        const ag = conversationAgencies.find((a) => Number(a.id) === Number(msg.case_agency_id));
        if (ag) assigned.set(msg.id, `agency-${ag.id}`);
      }
    }

    // Pass 2: exact email match
    for (const msg of _threadMessages) {
      if (assigned.has(msg.id)) continue;
      const from = String(msg.from_email || "").trim().toLowerCase();
      const to = String(msg.to_email || "").trim().toLowerCase();
      for (const ag of conversationAgencies) {
        const emails = parseEmailList(ag.agency_email);
        if (emails.some((e) => e === from || e === to)) {
          assigned.set(msg.id, `agency-${ag.id}`);
          break;
        }
      }
    }

    // Pass 3: domain match (only if not yet assigned)
    for (const msg of _threadMessages) {
      if (assigned.has(msg.id)) continue;
      const fromD = emailDomain(String(msg.from_email || ""));
      const toD = emailDomain(String(msg.to_email || ""));
      for (const ag of conversationAgencies) {
        const domains = parseEmailList(ag.agency_email).map((e) => emailDomain(e)).filter(Boolean);
        if (domains.some((d) => d === fromD || d === toD)) {
          assigned.set(msg.id, `agency-${ag.id}`);
          break;
        }
      }
    }

    // Pass 4: name token match
    for (const msg of _threadMessages) {
      if (assigned.has(msg.id)) continue;
      const text = `${msg.subject || ""}\n${msg.body || ""}`.toLowerCase();
      for (const ag of conversationAgencies) {
        const tokens = normalizeAgencyKey(ag.agency_name);
        if (tokens.length > 0 && tokens.some((t) => text.includes(t))) {
          assigned.set(msg.id, `agency-${ag.id}`);
          break;
        }
      }
    }

    // Build per-agency buckets from assignments
    const coveredAgencyIds = new Set<number>();
    for (const ag of conversationAgencies) {
      const bucketId = `agency-${ag.id}`;
      coveredAgencyIds.add(ag.id);
      const messageIds = new Set<number>();
      for (const [msgId, bid] of assigned) {
        if (bid === bucketId) messageIds.add(msgId);
      }
      buckets.push({
        id: bucketId,
        label: ag.agency_name || `Agency ${ag.id}`,
        count: messageIds.size,
        messageIds,
        proposals: proposalsByAgencyBucket.get(bucketId) || [],
      });
    }

    // Synthetic tabs for proposals whose case_agency_id doesn't match any existing bucket
    for (const p of _pendingProposals) {
      if (p.case_agency_id != null && !coveredAgencyIds.has(p.case_agency_id)) {
        const bucketId = `agency-${p.case_agency_id}`;
        if (buckets.some(b => b.id === bucketId)) continue;
        const agencyFromCase = _caseAgencies.find(ca => ca.id === p.case_agency_id);
        coveredAgencyIds.add(p.case_agency_id);
        buckets.push({
          id: bucketId,
          label: agencyFromCase?.agency_name || p.agency_name || `Agency ${p.case_agency_id}`,
          count: 0,
          messageIds: new Set(),
          proposals: proposalsByAgencyBucket.get(bucketId) || [],
        });
      }
    }

    // "Other" for unassigned messages
    const otherIds = new Set(
      _threadMessages.filter((m) => !assigned.has(m.id)).map((m) => m.id)
    );
    if (otherIds.size > 0) {
      buckets.push({ id: "other", label: "Other", count: otherIds.size, messageIds: otherIds, proposals: [] });
    }
    return buckets;
  }, [_threadMessages, conversationAgencies, shouldShowConversationTabs, _pendingProposals, proposalsByAgencyBucket, _caseAgencies]);

  const agencyMessageStats = useMemo(() => {
    const recordedSubmissionAt =
      data?.request?.submitted_at ||
      data?.request?.send_date ||
      null;
    const singleAgencyCase = _activeCaseAgencies.length === 1;
    const stats = new Map<number, {
      total: number;
      inbound: number;
      outbound: number;
      lastMessageAt: string | null;
      recordedSubmissionAt: string | null;
    }>();
    for (const agency of _activeCaseAgencies) {
      let total = 0, inbound = 0, outbound = 0;
      let lastMessageAt: string | null = null;
      for (const message of _threadMessages) {
        if (messageMatchesAgency(message, agency)) {
          total++;
          if (message.direction === "INBOUND") inbound++;
          else outbound++;
          if (!lastMessageAt || message.sent_at > lastMessageAt) {
            lastMessageAt = message.sent_at;
          }
        }
      }
      const shouldAttributeRecordedSubmission =
        Boolean(recordedSubmissionAt) &&
        outbound === 0 &&
        (agency.is_primary || singleAgencyCase);
      stats.set(agency.id, {
        total,
        inbound,
        outbound,
        lastMessageAt,
        recordedSubmissionAt: shouldAttributeRecordedSubmission ? recordedSubmissionAt : null,
      });
    }
    return stats;
  }, [_threadMessages, _activeCaseAgencies, data?.request?.submitted_at, data?.request?.send_date]);

  useEffect(() => {
    if (!conversationBuckets.some((bucket) => bucket.id === conversationTab)) {
      setConversationTab("all");
    }
  }, [conversationBuckets, conversationTab]);

  const visibleThreadMessages = useMemo(() => {
    const selected = conversationBuckets.find((bucket) => bucket.id === conversationTab);
    const real = (!selected || conversationTab === "all")
      ? _threadMessages
      : _threadMessages.filter((message) => selected.messageIds.has(message.id));
    // Filter optimistic messages by agency tab
    const filteredOptimistic = conversationTab === "all"
      ? optimisticMessages
      : optimisticMessages.filter((m: any) => {
          if (m.case_agency_id == null) return true;
          return conversationTab === `agency-${m.case_agency_id}`;
        });
    return [...real, ...filteredOptimistic];
  }, [_threadMessages, conversationBuckets, conversationTab, optimisticMessages]);

  const liveRun = useMemo(() => {
    const list = runsData?.runs || [];
    return list.find((r) => ["running", "queued", "created", "processing"].includes(String(r.status).toLowerCase())) || null;
  }, [runsData?.runs]);
  const activeWorkspaceRun = useMemo(() => {
    const status = String((data as any)?.active_run?.status || "").toLowerCase();
    if (!status) return null;
    return ["running", "queued", "created", "processing", "waiting"].includes(status) ? (data as any).active_run : null;
  }, [data]);
  const liveRunLabel = useMemo(() => formatLiveRunLabel(liveRun), [liveRun]);
  const portalTaskActive = useMemo(() => {
    const status = String(data?.request?.active_portal_task_status || "").toUpperCase();
    return status === "PENDING" || status === "IN_PROGRESS";
  }, [data?.request?.active_portal_task_status]);
  const waitingRun = useMemo(() => {
    const list = runsData?.runs || [];
    return list.find((r) => String(r.status).toLowerCase() === "waiting") || null;
  }, [runsData?.runs]);
  const hasExecutionInFlight = useMemo(() => {
    const workspaceStatus = String(activeWorkspaceRun?.status || "").toLowerCase();
    return Boolean(
      liveRun || portalTaskActive ||
      ["running", "queued", "created", "processing"].includes(workspaceStatus)
    );
  }, [liveRun, portalTaskActive, activeWorkspaceRun]);
  const unprocessedInboundMessages = useMemo(() => {
    if (!data?.thread_messages) return [];
    return data.thread_messages.filter(m => m.direction === "INBOUND" && !m.processed_at);
  }, [data?.thread_messages]);

  // Auto-clear optimistic messages
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    setOptimisticMessages(prev => prev.filter(opt => {
      const hasReal = _threadMessages.some(m =>
        m.direction === 'OUTBOUND' && m.id > 0 && (
          (
            String(m.subject || '').trim() !== '' &&
            String(m.subject || '').trim() === String(opt.subject || '').trim() &&
            String(m.to_email || '').trim().toLowerCase() === String(opt.to_email || '').trim().toLowerCase()
          ) ||
          new Date((m.sent_at || m.timestamp) as string).getTime() >= new Date(opt.sent_at).getTime() - 5000
        )
      );
      return !hasReal;
    }));
  }, [_threadMessages]);
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    const timer = setTimeout(() => setOptimisticMessages([]), 120_000);
    return () => clearTimeout(timer);
  }, [optimisticMessages.length]);

  useEffect(() => {
    if (!pendingSubmission) return;
    const stillExists = _pendingProposals.some(p => p.id === pendingSubmission.proposalId);
    // Clear when the submitted proposal is no longer in the array and other proposals exist
    if (!stillExists && _pendingProposals.length > 0) {
      setPendingSubmission(null);
    }
  }, [pendingSubmission, _pendingProposals]);

  useEffect(() => {
    if (!pendingSubmission) return;
    const timer = setTimeout(() => setPendingSubmission(null), 120_000);
    return () => clearTimeout(timer);
  }, [pendingSubmission]);

  useEffect(() => {
    if (!pendingSubmission) return;
    const noPendingProposal = _pendingProposals.length === 0;
    const noExecutionInFlight = !hasExecutionInFlight;
    if (noPendingProposal && noExecutionInFlight) {
      setPendingSubmission(null);
      setPendingUiLockUntil(0);
      setOptimisticMessages([]);
    }
  }, [pendingSubmission, _pendingProposals, hasExecutionInFlight]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleApprovePending = async (proposalId: number) => {
    const proposal = _pendingProposals.find(p => p.id === proposalId);
    if (!proposal) return;
    const draft = getDraft(proposalId);
    setIsApproving(true);
    const actionType = proposal.action_type || "";
    const nonEmailActions = ["RESEARCH_AGENCY", "ESCALATE", "WITHDRAW"];
    const shouldOptimisticMessage = !nonEmailActions.includes(actionType) && Boolean(draft.editedBody || proposal.draft_body_text);
    const optimisticMessageId = -Date.now();
    if (shouldOptimisticMessage) {
      setOptimisticMessages(prev => [...prev, {
        id: optimisticMessageId, direction: 'OUTBOUND' as const, channel: 'EMAIL' as const,
        from_email: '', to_email: draft.editedRecipient || data!.request.agency_email || '',
        subject: draft.editedSubject || proposal.draft_subject || '',
        body: draft.editedBody || proposal.draft_body_text || '',
        sent_at: new Date().toISOString(), timestamp: new Date().toISOString(),
        attachments: [], _sending: true as const,
        case_agency_id: proposal.case_agency_id ?? undefined,
      } as any]);
    }
    setPendingSubmission({ proposalId, startedAt: Date.now() });
    setPendingUiLockUntil(Date.now() + 45_000);
    try {
      const body: Record<string, unknown> = { action: "APPROVE" };
      if (draft.editedBody && draft.editedBody !== (proposal.draft_body_text || "")) body.draft_body_text = draft.editedBody;
      if (draft.editedSubject && draft.editedSubject !== (proposal.draft_subject || "")) body.draft_subject = draft.editedSubject;
      if (draft.proposalAttachments.length > 0) body.attachments = draft.proposalAttachments;
      if (draft.editedRecipient && draft.editedRecipient !== originalRecipient) body.recipient_override = draft.editedRecipient;
      if (actionType === "ESCALATE") {
        body.instruction = (typeof draft.editedBody === "string" && draft.editedBody.trim().length > 0)
          ? draft.editedBody.trim()
          : "Use the current primary agency and existing contact data to generate a concrete next proposal to restart the request (prefer SUBMIT_PORTAL or SEND_INITIAL_REQUEST). Do not return ESCALATE again unless truly blocked.";
      }
      const chain = proposal.action_chain;
      if (chain && chain.length > 1) {
        if (draft.editedChainBody && draft.editedChainBody !== (chain[1].draftBodyText || "")) body.chain_draft_body_text = draft.editedChainBody;
        if (draft.editedChainSubject && draft.editedChainSubject !== (chain[1].draftSubject || "")) body.chain_draft_subject = draft.editedChainSubject;
      }
      const res = await fetch(`/api/proposals/${proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      if (shouldOptimisticMessage) {
        toast.success("Sending...");
      } else {
        toast.success("Approved");
      }
      optimisticClear(proposalId);
    } catch (e: any) {
      if (shouldOptimisticMessage) {
        setOptimisticMessages(prev => prev.filter((m) => m.id !== optimisticMessageId));
      }
      setPendingSubmission(null);
      setPendingUiLockUntil(0);
      toast.error(e.message);
    } finally {
      setIsApproving(false);
    }
  };

  const handleFeeWorkflowDecision = async (
    proposalId: number,
    action: "ADD_TO_INVOICING" | "WAIT_FOR_GOOD_TO_PAY"
  ) => {
    setIsApproving(true);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      toast.success(action === "ADD_TO_INVOICING" ? "Added to invoicing" : "Waiting for good to pay");
      await mutate();
      mutateRuns();
      startPolling();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsApproving(false);
    }
  };

  const handleDismissPending = async (proposalId: number, reason: string) => {
    const proposal = _pendingProposals.find(p => p.id === proposalId);
    if (!proposal) return;
    try {
      const res = await fetch(`/api/proposals/${proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "DISMISS", dismiss_reason: reason }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      optimisticClear(proposalId);
      toast.success("Proposal dismissed");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleAdjustPending = async (instruction: string) => {
    if (pendingAdjustProposalId == null) return;
    const proposal = _pendingProposals.find(p => p.id === pendingAdjustProposalId);
    if (!proposal) return;
    setIsAdjustingPending(true);
    try {
      const res = await fetch(`/api/proposals/${proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ADJUST", instruction: instruction.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      setPendingAdjustModalOpen(false);
      setPendingAdjustProposalId(null);
      optimisticClear(pendingAdjustProposalId);
      toast.success("Adjusting draft...");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsAdjustingPending(false);
    }
  };

  const handleRetryResearch = async (proposalId: number) => {
    const proposal = _pendingProposals.find(p => p.id === proposalId);
    if (!proposal) return;
    setIsApproving(true);
    try {
      const res = await fetch(`/api/proposals/${proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RETRY_RESEARCH" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      optimisticClear(proposalId);
      toast.success("Research retry started...");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsApproving(false);
    }
  };

  const handleManualSubmit = async (proposalId: number) => {
    const proposal = _pendingProposals.find(p => p.id === proposalId);
    if (!proposal) return;
    setIsManualSubmitting(true);
    try {
      const res = await fetch(`/api/proposals/${proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "MANUAL_SUBMIT" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      optimisticClear(proposalId);
      toast.success("Marked as submitted");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsManualSubmitting(false);
    }
  };

  const handleProceed = async (costCap?: number) => {
    if (!id) return;
    setIsApproving(true);
    try {
      const result = await requestsAPI.approve(id, nextAction?.id, costCap);
      setProposalState("QUEUED");
      const minDelay = 2 * 60 * 60 * 1000;
      const maxDelay = 10 * 60 * 60 * 1000;
      const estimated = new Date(Date.now() + minDelay + Math.random() * (maxDelay - minDelay));
      setScheduledSendAt(result?.scheduled_send_at || estimated.toISOString());
      optimisticClear();
    } finally {
      setIsApproving(false);
    }
  };

  const handleRevise = async (instruction: string) => {
    if (!id) return;
    setIsRevising(true);
    try {
      const result = await requestsAPI.revise(id, instruction, nextAction?.id);
      if (result.next_action_proposal) setNextAction(result.next_action_proposal);
      setAdjustModalOpen(false);
      mutate();
    } catch (error: any) {
      toast.error(error.message || "Failed to revise action");
    } finally {
      setIsRevising(false);
    }
  };

  const handleResolveReview = async (action: string, instruction?: string) => {
    if (!id) return;
    setIsResolving(true);
    try {
      if (action === "submit_manually") {
        const primaryAgency = data?.case_agencies?.find((agency) => agency.is_primary) || null;
        const manualTarget =
          resolvePortalUrl(data?.request?.portal_url ?? null, agency_summary?.portal_url ?? null) ||
          resolveManualRequestUrl(data?.request?.manual_request_url ?? null, primaryAgency?.manual_request_url ?? null) ||
          resolvePdfFormUrl(data?.request?.pdf_form_url ?? null, primaryAgency?.pdf_form_url ?? null);
        if (manualTarget) {
          window.open(manualTarget, "_blank");
        }
      }
      await requestsAPI.resolveReview(id, action, instruction);
      optimisticClear();
    } catch (error: any) {
      toast.error(error.message || "Failed to resolve review");
    } finally {
      setIsResolving(false);
    }
  };

  const handleWithdraw = async () => {
    if (!id) return;
    setIsResolving(true);
    try {
      await requestsAPI.withdraw(id, "Withdrawn by user");
      setWithdrawDialogOpen(false);
      mutate();
      router.push("/requests");
    } catch (error) {
      toast.error("Failed to withdraw request");
    } finally {
      setIsResolving(false);
    }
  };

  const handleMarkBugged = async () => {
    if (!id) return;
    setIsResolving(true);
    try {
      await fetchAPI(`/requests/${id}/mark-bugged`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: bugDescription || "Marked as bugged from dashboard" }),
      });
      setBugDialogOpen(false);
      setBugDescription("");
      mutate();
      toast.success("Case marked as bugged");
    } catch (error) {
      toast.error("Failed to mark case as bugged");
    } finally {
      setIsResolving(false);
    }
  };

  const handleRemoveConstraint = async (index: number) => {
    if (!id) return;
    try {
      await fetchAPI(`/requests/${id}/constraints/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      mutate();
      toast.success("Constraint removed");
    } catch {
      toast.error("Failed to remove constraint");
    }
  };

  const handleAddConstraint = async () => {
    if (!id || !newConstraintDesc.trim()) return;
    try {
      await fetchAPI(`/requests/${id}/constraints/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newConstraintType, description: newConstraintDesc.trim() }),
      });
      mutate();
      setAddConstraintOpen(false);
      setNewConstraintDesc("");
      toast.success("Constraint added");
    } catch {
      toast.error("Failed to add constraint");
    }
  };

  const handleGenerateInitialRequest = async () => {
    if (!id) return;
    setIsGeneratingInitial(true);
    try {
      const result = await casesAPI.runInitial(parseInt(id), { autopilotMode: 'SUPERVISED' });
      if (result.success) { mutate(); mutateRuns(); startPolling(); }
      else toast.error("Failed to generate initial request");
    } catch (error: any) {
      toast.error(error.message || "Failed to generate initial request");
    } finally {
      setIsGeneratingInitial(false);
    }
  };

  const handleInvokeAgent = async () => {
    if (!id) return;
    setIsInvokingAgent(true);
    try {
      const result = await requestsAPI.invokeAgent(id);
      if (result.success) { mutate(); mutateRuns(); startPolling(); }
      else toast.error(result.message || "Failed to invoke agent");
    } catch (error: any) {
      toast.error(error.message || "Failed to invoke agent");
    } finally {
      setIsInvokingAgent(false);
    }
  };

  const handleRunFollowup = async () => {
    if (!id) return;
    setIsRunningFollowup(true);
    try {
      const result = await casesAPI.runFollowup(parseInt(id), { autopilotMode: 'SUPERVISED' });
      if (result.success) { mutate(); mutateRuns(); startPolling(); }
      else toast.error("Failed to trigger follow-up");
    } catch (error: any) {
      toast.error(error.message || "Failed to trigger follow-up");
    } finally {
      setIsRunningFollowup(false);
    }
  };

  const handleRunInbound = async (messageId: number) => {
    if (!id) return;
    setIsRunningInbound(true);
    try {
      const result = await casesAPI.runInbound(parseInt(id), messageId, { autopilotMode: 'SUPERVISED' });
      if (result.success) { mutate(); mutateRuns(); setShowInboundDialog(false); setSelectedMessageId(null); startPolling(); }
      else toast.error("Failed to process inbound message");
    } catch (error: any) {
      toast.error(error.message || "Failed to process inbound message");
    } finally {
      setIsRunningInbound(false);
    }
  };

  const handleResimulateLatestInbound = async () => {
    if (!id || !lastInboundMessage) return;
    setIsRunningInbound(true);
    try {
      const result = await casesAPI.runInbound(parseInt(id), lastInboundMessage.id, { autopilotMode: 'SUPERVISED' });
      if (result.success) { mutate(); mutateRuns(); startPolling(); }
      else toast.error("Failed to resimulate inbound message");
    } catch (error: any) {
      toast.error(error.message || "Failed to resimulate inbound message");
    } finally {
      setIsRunningInbound(false);
    }
  };

  const handleResetToLastInbound = async () => {
    if (!id) return;
    const ok = window.confirm("Reset this case to the latest inbound message?\n\nThis will dismiss active proposals, clear in-flight run state, and reprocess from the latest inbound.");
    if (!ok) return;
    setIsResettingCase(true);
    try {
      const result = await requestsAPI.resetToLastInbound(id);
      if (result.success) { mutate(); mutateRuns(); startPolling(); }
      else toast.error("Failed to reset case");
    } catch (error: any) {
      toast.error(error.message || "Failed to reset case");
    } finally {
      setIsResettingCase(false);
    }
  };

  const handleGuideAI = async (instruction: string) => {
    if (!id || !instruction.trim()) return;
    setIsGuidingAI(true);
    try {
      let handled = false;
      try {
        const reviewResult = await requestsAPI.resolveReview(id, "custom", instruction.trim());
        if (reviewResult?.success) handled = true;
      } catch { /* fallback */ }
      if (!handled && nextAction?.id) {
        const revised = await requestsAPI.revise(id, instruction.trim(), nextAction.id);
        if (revised?.success !== false) handled = true;
      }
      if (!handled) { await requestsAPI.resetToLastInbound(id); handled = true; }
      if (handled) {
        setGuideModalOpen(false);
        mutate(); mutateRuns(); startPolling();
        toast.success("Guidance submitted. AI is generating the next step.");
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to guide AI");
    } finally {
      setIsGuidingAI(false);
    }
  };

  const handleSendMessage = async (content: string, attachments?: Array<{ filename: string; content: string; type: string }>) => {
    if (!id || !content.trim()) return;
    try {
      const result = await requestsAPI.sendManual(id, content.trim(), {
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      });
      await mutate();
      toast.success(`Manual email sent to ${result.to_email}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to send manual email");
      throw error;
    }
  };

  const handleAddToPhoneQueue = async () => {
    if (!id) return;
    try {
      const res = await fetch("/api/phone-calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: Number(id), reason: "manual_add", notes: "Added from case detail page" }),
      });
      const data = await res.json();
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || "Failed to add to phone call queue");
      }
      if (data.already_exists) toast.info("Already in the phone call queue");
      else toast.success("Added to phone call queue");
      mutate();
    } catch (error: any) {
      toast.error(error?.message || "Failed to add to phone queue");
    }
  };

  const handleMakePhoneCall = () => {
    setShowCorrespondenceDialog(true);
  };

  // ── Multi-agency handlers ──────────────────────────────────────────────────

  const handleSetPrimaryAgency = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoading({ id: caseAgencyId, action: "primary" });
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/set-primary`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to set primary agency");
      mutate();
    } catch (e: any) {
      toast.error(e.message || "Failed to set primary agency");
    } finally {
      setAgencyActionLoading(null);
    }
  };

  const handleRemoveAgency = async (caseAgencyId: number, agencyName: string) => {
    if (!id) return;
    if (!confirm(`Remove "${agencyName}" from this case?`)) return;
    setAgencyActionLoading({ id: caseAgencyId, action: "remove" });
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to remove agency");
      mutate();
      toast.success(`Removed "${agencyName}"`);
    } catch (e: any) {
      toast.error(e.message || "Failed to remove agency");
    } finally {
      setAgencyActionLoading(null);
    }
  };

  const handleResearchAgency = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoading({ id: caseAgencyId, action: "research" });
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/research`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to research agency");
      await mutate();
      toast.success("Agency research completed");
    } catch (e: any) {
      toast.error(e.message || "Failed to research agency");
    } finally {
      setAgencyActionLoading(null);
    }
  };

  const handleConfirmPortal = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoading({ id: caseAgencyId, action: "confirm-portal" });
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/portal/confirm`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to confirm portal");
      await mutate();
      toast.success("Portal confirmed for automation");
    } catch (e: any) {
      toast.error(e.message || "Failed to confirm portal");
    } finally {
      setAgencyActionLoading(null);
    }
  };

  const handleBlockPortal = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoading({ id: caseAgencyId, action: "block-portal" });
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/portal/block`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to mark portal manual-only");
      await mutate();
      toast.success("Portal marked manual-only");
    } catch (e: any) {
      toast.error(e.message || "Failed to mark portal manual-only");
    } finally {
      setAgencyActionLoading(null);
    }
  };

  const handleValidatePortal = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoading({ id: caseAgencyId, action: "validate-portal" });
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/portal/validate`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to validate portal");
      await mutate();
      toast.success(json.message || "Portal validation complete");
    } catch (e: any) {
      toast.error(e.message || "Failed to validate portal");
    } finally {
      setAgencyActionLoading(null);
    }
  };

  const handleStartRequestForAgency = async (caseAgencyId: number, freshCaseAgency?: CaseAgency) => {
    if (!id) return;
    const caseId = parseInt(id, 10);
    const caseAgency = freshCaseAgency || _caseAgencies.find((ca) => Number(ca.id) === Number(caseAgencyId));
    if (!caseAgency) {
      toast.error("Agency not found on this case");
      return;
    }

    setAgencyStartLoadingId(caseAgencyId);
    try {
      if (!caseAgency.is_primary) {
        const setPrimaryRes = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/set-primary`, { method: "POST" });
        const setPrimaryJson = await setPrimaryRes.json();
        if (!setPrimaryRes.ok || !setPrimaryJson.success) {
          throw new Error(setPrimaryJson.error || "Failed to set primary agency");
        }
      }
      const routeMode =
        caseAgency.portal_url ? "portal" : caseAgency.agency_email ? "email" : undefined;
      const runResult = await casesAPI.runInitial(caseId, {
        autopilotMode: "SUPERVISED",
        routeMode,
        forceRestart: true,
      });
      if (!runResult.success) {
        throw new Error("Failed to queue request processing");
      }
      mutate();
      mutateRuns();
      startPolling();
    } catch (e: any) {
      toast.error(e.message || "Failed to start request for agency");
    } finally {
      setAgencyStartLoadingId(null);
    }
  };

  const createCaseAgency = async (agency: {
    agency_name: string;
    agency_email?: string;
    portal_url?: string;
    notes?: string;
    added_source?: string;
  }) => {
    if (!id) throw new Error("Missing case id");
    const res = await fetch(`/api/cases/${id}/agencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agency),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.error || "Failed to add agency");
    }
    return json.case_agency as CaseAgency;
  };

  const handleAddCandidateAgency = async (candidate: AgencyCandidate, startAfterAdd = false) => {
    if (!id || !candidate?.name) return;
    if (startAfterAdd) {
      setCandidateStartLoadingName(candidate.name);
    } else {
      setCandidateActionLoadingName(candidate.name);
    }
    try {
      const caseAgency = await createCaseAgency({
        agency_name: candidate.name,
        agency_email: candidate.agency_email || undefined,
        portal_url: candidate.portal_url || undefined,
        notes: candidate.reason || undefined,
        added_source: candidate.source || "research_candidate",
      });
      if (startAfterAdd && caseAgency?.id) {
        await handleStartRequestForAgency(caseAgency.id, caseAgency);
      } else {
        mutate();
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to add agency candidate");
    } finally {
      setCandidateActionLoadingName(null);
      setCandidateStartLoadingName(null);
    }
  };

  const handleAddManualAgency = async (startAfterAdd = false) => {
    if (!manualAgencyName.trim()) {
      toast.error("Agency name is required");
      return;
    }
    setIsManualAgencySubmitting(true);
    try {
      const caseAgency = await createCaseAgency({
        agency_name: manualAgencyName.trim(),
        agency_email: manualAgencyEmail.trim() || undefined,
        portal_url: manualAgencyPortalUrl.trim() || undefined,
        added_source: "manual",
      });
      setManualAgencyName("");
      setManualAgencyEmail("");
      setManualAgencyPortalUrl("");
      mutate();
      if (startAfterAdd && caseAgency?.id) {
        try {
          await handleStartRequestForAgency(caseAgency.id, caseAgency);
        } catch (startErr: any) {
          toast.error(`Agency added, but could not start request: ${startErr.message || "active run exists"}`);
        }
      }
    } catch (e: any) {
      toast.error(e.message || "Failed to add agency");
    } finally {
      setIsManualAgencySubmitting(false);
    }
  };

  const copyField = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(key);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const constraintHistory = useMemo(() => {
    // Prefer dedicated constraint_history from workspace API (not subject to timeline LIMIT)
    const dedicated = (data as any)?.constraint_history;
    if (Array.isArray(dedicated) && dedicated.length > 0) {
      return dedicated.map((h: any) => ({
        timestamp: h.timestamp,
        action: h.event === "constraint_removed" ? "removed" as const
          : h.event === "constraint_added" ? "added" as const
          : "detected" as const,
        description: h.description,
        actor: h.actor === "human" ? "operator" : (h.source || "AI"),
        constraint: h.constraint,
      })).slice(0, 20);
    }
    // Fallback: parse from timeline_events
    const events = (data as any)?.timeline_events || [];
    const eventTypes = new Set(["constraint_added", "constraint_removed", "constraint_detected"]);
    return events
      .filter((e: any) => eventTypes.has(e.metadata?.event_type))
      .map((e: any) => ({
        timestamp: e.timestamp,
        action: e.metadata?.event_type === "constraint_removed" ? "removed" as const
          : e.metadata?.event_type === "constraint_added" ? "added" as const
          : "detected" as const,
        description: e.summary,
        actor: e.metadata?.user_id || (e.metadata?.event_type === "constraint_detected" ? "AI" : undefined),
      }))
      .slice(0, 10);
  }, [data]);

  // ── Early returns ──────────────────────────────────────────────────────────

  if (!id) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">No request ID provided</p>
        <Link href="/requests" className="text-primary hover:underline mt-4 inline-block">Back to Requests</Link>
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load request</p>
        <p className="text-sm text-muted-foreground">{error?.message || "Request not found"}</p>
        <Link href="/requests" className="text-primary hover:underline mt-4 inline-block">Back to Requests</Link>
      </div>
    );
  }

  // ── Destructure ────────────────────────────────────────────────────────────
  const {
    request, timeline_events, agency_summary, deadline_milestones, state_deadline,
    pending_proposal, portal_helper, review_state, control_state,
    control_mismatches = [], active_run, agent_decisions = [],
    case_agencies = [], agency_candidates = [],
  } = data as RequestWorkspaceResponse & { case_agencies?: CaseAgency[]; agency_candidates?: AgencyCandidate[] };
  const pendingAgencyCandidatesCount = agency_candidates.length;

  // ── Tags ────────────────────────────────────────────────────────────────────
  const PRESET_TAGS = ["ai wrong", "agency difficult", "unusual", "high priority", "needs review", "escalated"];
  const currentTags: string[] = request?.tags || [];

  const handleAddTag = async (tag: string) => {
    if (!id || !tag.trim()) return;
    const cleaned = tag.trim().toLowerCase();
    if (currentTags.includes(cleaned)) return;
    const newTags = [...currentTags, cleaned];
    setTagSaving(true);
    try {
      await fetchAPI(`/requests/${id}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: newTags }),
      });
      mutate();
      setTagInput("");
      toast.success(`Tag "${cleaned}" added`);
    } catch {
      toast.error("Failed to update tags");
    } finally {
      setTagSaving(false);
    }
  };

  const handleRemoveTag = async (tag: string) => {
    if (!id) return;
    const newTags = currentTags.filter(t => t !== tag);
    setTagSaving(true);
    try {
      await fetchAPI(`/requests/${id}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: newTags }),
      });
      mutate();
      toast.success(`Tag "${tag}" removed`);
    } catch {
      toast.error("Failed to update tags");
    } finally {
      setTagSaving(false);
    }
  };

  // Per-proposal derived values (pendingActionType, isEmailLikePendingAction, etc.)
  // are now computed inside the proposal card render loop.

  const statusValue = String(request.status || "").toUpperCase();
  const isPausedStatus = [
    "PAUSED",
    "NEEDS_HUMAN_REVIEW",
    "NEEDS_CONTACT_INFO",
    "NEEDS_HUMAN_FEE_APPROVAL",
    "NEEDS_PHONE_CALL",
    "NEEDS_REBUTTAL",
    "PENDING_FEE_DECISION",
  ].includes(statusValue);
  const staleReviewStatus = isPausedStatus && !request.requires_human && review_state !== "DECISION_REQUIRED";
  const statusDisplay = staleReviewStatus
    ? "AWAITING_RESPONSE"
    : isPausedStatus && !hasExecutionInFlight
      ? statusValue
      : isPausedStatus && hasExecutionInFlight
        ? "PROCESSING"
        : (request.status || "—");

  const decisionRequired = review_state
    ? review_state === "DECISION_REQUIRED"
    : (Boolean(request.pause_reason) || request.requires_human || isPausedStatus);
  const isPaused = decisionRequired && !hasExecutionInFlight;
  // Global: are ANY proposals currently being applied? Used for broad UI gating
  const isAnyProposalApplying =
    _pendingProposals.length > 0 &&
    (
      Date.now() < pendingUiLockUntil ||
      review_state === "DECISION_APPLYING" ||
      (hasExecutionInFlight && review_state !== "DECISION_REQUIRED")
    );

  const controlDisplay = getControlStateDisplay(control_state);
  const ControlStateIcon = controlDisplay.icon;
  const submittedAtDisplay =
    request.submitted_at ||
    request.send_date ||
    _threadMessages.find((m) => m.direction === "OUTBOUND")?.timestamp ||
    null;
  const hasRecordedSubmissionWithoutThread =
    visibleThreadMessages.length === 0 && Boolean(submittedAtDisplay);
  const agentDecisions: AgentDecision[] = data.agent_decisions || [];
  const hasPortalHistory = !!request.last_portal_status && !portalTaskActive;

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] min-w-0 overflow-x-hidden">
      {/* ── HEADER ─── 2 lines, max ~56px ──────────────────────────────────── */}
      <div className="shrink-0 border-b border-border/50 px-3 py-1.5">
        {/* Line 1: back + case identity + controls */}
        <div className="flex flex-wrap items-center gap-2 min-h-[28px]">
          {/* Row 1: identity */}
          <button
            onClick={() => router.push("/requests")}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs font-mono text-muted-foreground">#{request.id}</span>
          <span className="text-sm font-semibold truncate">{stripHtmlTags(request.subject)}</span>
          <div className="flex-1 hidden md:block" />
          {/* Row 2 on mobile: controls */}
          <div className="flex flex-wrap items-center gap-1.5 w-full md:w-auto">
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1 py-0 shrink-0",
              statusDisplay === "PAUSED" ? "border-amber-700/50 bg-amber-500/10 text-amber-300"
                : statusDisplay === "PROCESSING" ? "border-blue-700/50 bg-blue-500/10 text-blue-300" : ""
            )}
          >
            {statusDisplay}
          </Badge>
          <span className="text-xs text-muted-foreground truncate">{request.agency_name}</span>
          {request.state && (
            <span className="text-[10px] text-muted-foreground font-mono shrink-0">{request.state}</span>
          )}
          <div className="flex-1" />
          {/* Controls */}
          <Select
            value={String(request.priority ?? 0)}
            onValueChange={async (val) => {
              try {
                await fetchAPI(`/requests/${id}/priority`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ priority: parseInt(val) }),
                });
                mutate();
              } catch {}
            }}
          >
            <SelectTrigger className={cn(
              "h-6 w-auto gap-1 px-1.5 text-[10px] border rounded shrink-0",
              request.priority === 2 && "border-red-500 text-red-400",
              request.priority === 1 && "border-muted text-muted-foreground",
            )}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2"><span className="flex items-center gap-1"><ArrowUp className="h-2.5 w-2.5 text-red-400" />Urgent</span></SelectItem>
              <SelectItem value="0">Normal</SelectItem>
              <SelectItem value="1">Low</SelectItem>
            </SelectContent>
          </Select>
          <AutopilotSelector
            requestId={request.id}
            currentMode={request.autopilot_mode}
            onModeChange={() => mutate()}
            compact
          />
          <div className={cn("flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] shrink-0", controlDisplay.className)}>
            <ControlStateIcon className={cn("h-2.5 w-2.5", control_state === "WORKING" && "animate-spin")} />
            <span className="font-medium">{controlDisplay.label}</span>
          </div>

          {/* Run dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={isInvokingAgent || isGeneratingInitial || isRunningFollowup || isRunningInbound || isResettingCase}>
                {(isInvokingAgent || isGeneratingInitial || isRunningFollowup || isRunningInbound || isResettingCase)
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Play className="h-3 w-3" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleGenerateInitialRequest}><Send className="h-3.5 w-3.5 mr-1.5" />Run Initial</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowInboundDialog(true)} disabled={unprocessedInboundMessages.length === 0}>
                <Inbox className="h-3.5 w-3.5 mr-1.5" />Run Inbound
                {unprocessedInboundMessages.length > 0 && <Badge variant="secondary" className="ml-1 text-[10px] px-1">{unprocessedInboundMessages.length}</Badge>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleResimulateLatestInbound} disabled={!lastInboundMessage}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Resimulate Inbound</DropdownMenuItem>
              <DropdownMenuItem onClick={handleRunFollowup}><RotateCcw className="h-3.5 w-3.5 mr-1.5" />Run Follow-up</DropdownMenuItem>
              <DropdownMenuItem onClick={handleResetToLastInbound} disabled={!lastInboundMessage || isResettingCase}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Reset + Reprocess</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleInvokeAgent}><Bot className="h-3.5 w-3.5 mr-1.5" />Re-process Case</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Overflow */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {request.notion_url && (
                <DropdownMenuItem onClick={() => window.open(request.notion_url!, "_blank")}>
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />Notion
                </DropdownMenuItem>
              )}
              {request.notion_url && (
                <DropdownMenuItem onClick={async () => {
                  try {
                    await fetchAPI(`/requests/${id}/sync-notion`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
                    toast.success("Notion sync triggered");
                    mutate();
                  } catch { toast.error("Notion sync failed"); }
                }}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />Sync Notion
                  {request.last_notion_synced_at && (
                    <span className="text-[10px] text-muted-foreground ml-1">
                      ({new Date(request.last_notion_synced_at).toLocaleDateString()})
                    </span>
                  )}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setSnoozeModalOpen(true)}><AlarmClock className="h-3.5 w-3.5 mr-1.5" />Snooze</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowCorrespondenceDialog(true)}><Phone className="h-3.5 w-3.5 mr-1.5" />Log Call</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowPasteInboundDialog(true)}><ClipboardPaste className="h-3.5 w-3.5 mr-1.5" />Paste Email</DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                const title = encodeURIComponent(`[Case #${id}] Issue Report`);
                const body = encodeURIComponent(
                  `## Case Context\n` +
                  `- **Case ID**: ${id}\n` +
                  `- **Status**: ${request.status}\n` +
                  `- **Substatus**: ${request.substatus || 'N/A'}\n` +
                  `- **Agency**: ${request.agency_name}\n` +
                  `- **Autopilot**: ${request.autopilot_mode}\n` +
                  `- **Control State**: ${control_state}\n` +
                  `- **Review State**: ${review_state}\n` +
                  `- **Active Run**: ${active_run?.status || 'none'}\n` +
                  `- **Pending Proposal**: ${pending_proposal ? `${pending_proposal.action_type} (${(pending_proposal as any).status})` : 'none'}\n` +
                  `- **Constraints**: ${request.constraints?.length || 0}\n\n` +
                  `## Issue Description\n\n_Describe the issue here..._\n\n` +
                  `## Expected Behavior\n\n_What should have happened..._\n`
                );
                window.open(`https://github.com/ShadewG/Autobot/issues/new?title=${title}&body=${body}&labels=bug,operator-report`, '_blank');
              }}>
                <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />Report Issue
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setBugDialogOpen(true)}>
                <Bug className="h-3.5 w-3.5 mr-1.5" />Mark as Bugged
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                window.open(`/api/requests/${id}/export?format=download`, '_blank');
              }}>
                <Download className="h-3.5 w-3.5 mr-1.5" />Export Package
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setWithdrawDialogOpen(true)}><Ban className="h-3.5 w-3.5 mr-1.5" />Withdraw</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>

        {/* Line 2: metrics bar */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground mt-0.5">
          <span>{daysOpen(submittedAtDisplay)} open</span>
          {(request.next_due_at || request.statutory_due_at) && (
            <>
              <span className="text-border hidden sm:inline">|</span>
              <span className={cn(
                request.due_info?.is_overdue ? "text-red-400" : "text-muted-foreground"
              )}>
                {daysUntilDue(request.next_due_at || request.statutory_due_at) || "—"}
              </span>
            </>
          )}
          {liveRunLabel && (
            <>
              <span className="text-border hidden sm:inline">|</span>
              <span className="text-blue-400 flex items-center gap-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {liveRunLabel}
              </span>
            </>
          )}
          {portalTaskActive && !liveRunLabel && (
            <>
              <span className="text-border hidden sm:inline">|</span>
              <span className="text-blue-400 flex items-center gap-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Portal submission
              </span>
            </>
          )}
          {/* Mismatch warning */}
          {(control_state === 'OUT_OF_SYNC' || control_mismatches.length > 0) && (
            <>
              <span className="text-border hidden sm:inline">|</span>
              <button
                className="text-red-400 flex items-center gap-1 hover:underline"
                onClick={handleResetToLastInbound}
                disabled={!lastInboundMessage || isResettingCase}
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                State mismatch — Fix
              </button>
            </>
          )}
          {/* Import validation warnings */}
          {Array.isArray(request.import_warnings) && request.import_warnings.length > 0 && (
            <div className="w-full mt-1.5 border border-yellow-700/50 bg-yellow-500/10 rounded px-2.5 py-1.5">
              <p className="text-[10px] font-semibold text-yellow-400 uppercase tracking-wider flex items-center gap-1 mb-1">
                <AlertTriangle className="h-3 w-3" />
                Import Warnings
              </p>
              <ul className="space-y-0.5">
                {request.import_warnings.map((w: any, i: number) => (
                  <li key={i} className="text-xs text-yellow-300/80 flex items-start gap-1">
                    <span className="text-yellow-500 mt-0.5">·</span>
                    <span>{w.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isAdmin && (liveRun?.trigger_run_id || activeWorkspaceRun?.trigger_run_id) && (
            <>
              <span className="text-border hidden sm:inline">|</span>
              <a
                href={buildTriggerRunUrl(liveRun?.trigger_run_id || activeWorkspaceRun?.trigger_run_id) || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                Trigger
              </a>
            </>
          )}
          <SafetyHints
            lastInboundProcessed={lastInboundMessage?.processed_at != null}
            lastInboundProcessedAt={lastInboundMessage?.processed_at || undefined}
            hasActiveRun={
              (runsData?.runs?.some(r => ['running', 'queued', 'created', 'processing'].includes(r.status)) || false) || portalTaskActive
            }
          />
        </div>
      </div>

      {/* ── TAGS BAR ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-1.5 px-4 py-1 border-b border-border/50 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Tag className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        {currentTags.map((tag) => (
          <Badge key={tag} variant="secondary" className="text-[10px] gap-1 flex-shrink-0">
            {tag}
            <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-400 transition-colors" disabled={tagSaving}>
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 px-1">
              <Plus className="h-2.5 w-2.5" />
              {currentTags.length === 0 ? "Add tag" : ""}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {PRESET_TAGS.filter(t => !currentTags.includes(t)).map((tag) => (
              <DropdownMenuItem key={tag} onClick={() => handleAddTag(tag)} className="text-xs">
                {tag}
              </DropdownMenuItem>
            ))}
            {PRESET_TAGS.filter(t => !currentTags.includes(t)).length > 0 && <DropdownMenuSeparator />}
            <div className="px-2 py-1.5">
              <form onSubmit={(e) => { e.preventDefault(); handleAddTag(tagInput); }} className="flex gap-1">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="Custom tag..."
                  className="h-6 text-xs"
                />
                <Button type="submit" size="sm" className="h-6 px-2 text-[10px]" disabled={!tagInput.trim() || tagSaving}>
                  Add
                </Button>
              </form>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── AI DECISION BAR — compact summary of latest AI action ─────────── */}
      {agentDecisions.length > 0 && isPaused && (() => {
        const latest = agentDecisions[0];
        const confPct = latest.confidence != null ? Math.round(latest.confidence * 100) : null;
        const reasonText = Array.isArray(latest.reasoning)
          ? latest.reasoning[0]
          : typeof latest.reasoning === "string" ? latest.reasoning : null;
        return (
          <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 border-b border-blue-700/20 bg-blue-950/10 text-xs">
            <span className="text-blue-400 font-medium shrink-0 flex items-center gap-1">
              <Brain className="h-3 w-3" /> AI:
            </span>
            <span className="font-medium">{(latest.action_taken || "").replace(/_/g, " ")}</span>
            {confPct != null && (
              <span className={cn(
                "tabular-nums",
                confPct >= 80 ? "text-green-400" : confPct >= 60 ? "text-amber-400" : "text-red-400"
              )}>
                {confPct}%
              </span>
            )}
            {reasonText && (
              <span className="text-muted-foreground truncate min-w-0">
                — {typeof reasonText === "string" ? reasonText.slice(0, 100) : ""}
              </span>
            )}
            {latest.outcome && (
              <Badge variant="outline" className="text-[10px] shrink-0">
                {latest.outcome.replace(/_/g, " ")}
              </Badge>
            )}
          </div>
        );
      })()}

      {/* ── MAIN BODY ─── two-panel split ──────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* ── LEFT PANEL: Main Content ─────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-border/50">
          {activeView === "thread" ? (
            /* ── THREAD VIEW (chat-style) ──────────────────────────────────── */
            <div className="flex-1 flex flex-col min-h-0">
              {/* Draft case CTA (shrink-0) */}
              {(request.status === 'DRAFT' || request.status === 'READY_TO_SEND') && !request.submitted_at && (
                <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-blue-500/5">
                  <Send className="h-3.5 w-3.5 text-blue-400" />
                  <span className="text-xs text-blue-300 font-medium">Ready to Submit</span>
                  <div className="flex-1" />
                  <Button size="sm" className="h-7 text-xs bg-blue-600 hover:bg-blue-500" onClick={handleGenerateInitialRequest} disabled={isGeneratingInitial}>
                    {isGeneratingInitial ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                    Generate Initial
                  </Button>
                </div>
              )}

              {/* Proposal status after approval (shrink-0) */}
              {proposalState !== "PENDING" && (
                <div className="shrink-0 px-3 py-2 border-b border-border/50">
                  <ProposalStatus state={proposalState} scheduledFor={scheduledSendAt} />
                </div>
              )}

              {/* Conversation tabs for multi-agency (shrink-0) */}
              {shouldShowConversationTabs && (
                <div className="shrink-0 px-3 py-1.5 border-b border-border/50">
                  <ScrollArea className="w-full whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      {conversationBuckets.map((bucket) => (
                        <Button
                          key={bucket.id}
                          variant={conversationTab === bucket.id ? "secondary" : "outline"}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setConversationTab(bucket.id)}
                          title={bucket.label}
                        >
                          <span className="max-w-[140px] truncate">{bucket.label}</span>
                          <Badge variant="secondary" className="ml-1 text-[10px] px-1">
                            {bucket.count}
                          </Badge>
                          {bucket.proposals.length > 0 && (
                            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                          )}
                        </Button>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}
              {!shouldShowConversationTabs && pendingAgencyCandidatesCount > 0 && (
                <div className="shrink-0 mx-3 mt-1.5 rounded border border-amber-700/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                  {pendingAgencyCandidatesCount} suggested agenc{pendingAgencyCandidatesCount === 1 ? "y" : "ies"} not yet added to case.
                  Add them in the <button className="font-medium underline" onClick={() => setActiveView("agency")}>Agency</button> tab to split conversation by agency.
                </div>
              )}

              {/* Thread (flex-1, fills remaining space) */}
              <div className="flex-1 min-h-0 overflow-hidden">
                {(() => {
                  const sub = (request.substatus || "").toLowerCase();
                  if (sub.includes("portal fail") || sub.includes("fallback")) {
                    return (
                      <div className="mx-3 mb-2 rounded border border-orange-600/40 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-200">
                        Email fallback to {request.agency_email || "agency"} (portal failed)
                      </div>
                    );
                  }
                  return null;
                })()}
                {hasRecordedSubmissionWithoutThread && (
                  <div className="mx-3 mb-2 rounded border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                    No email thread is stored for this case. The request was already submitted on{" "}
                    <span className="font-medium">{formatDate(submittedAtDisplay)}</span>, likely via portal or manual delivery, so follow-up/status proposals can still be valid.
                  </div>
                )}
                <Thread
                  messages={visibleThreadMessages}
                  maxHeight="h-full"
                  canonicalPortalUrl={resolvePortalUrl(request.portal_url, agency_summary?.portal_url ?? null)}
                  canonicalAgencyName={agency_summary?.name || request.agency_name}
                />
              </div>

              {/* Bottom action area (shrink-0, pinned at bottom) */}
              <div className="shrink-0 border-t border-border/50 max-h-[50%] overflow-y-auto">
                {(() => {
                  const selectedBucket = conversationBuckets.find(b => b.id === conversationTab);
                  const currentTabProposals = selectedBucket?.proposals || _pendingProposals;
                  if (currentTabProposals.length === 0) return null;
                  return currentTabProposals.map(proposal => {
                    const draft = getDraft(proposal.id);
                    const actionType = proposal.action_type || "";
                    const isEmailLike = EMAIL_ACTION_TYPES.includes(actionType);
                    const approveLabel = getProposalApproveLabel(
                      actionType,
                      proposal.action_chain?.length ?? 0
                    );
                    const delivery = getDeliveryTarget(actionType || null, request, agency_summary || null);
                    const manualPdfEscalation = actionType === "ESCALATE"
                      ? extractManualPdfEscalation(proposal.reasoning || [])
                      : null;
                    const isThisProposalApplying =
                      (pendingSubmission?.proposalId === proposal.id && Date.now() < pendingUiLockUntil) ||
                      String(proposal.status || "").toUpperCase() === "DECISION_RECEIVED";
                    // Resolve per-proposal recipient for display
                    const proposalRecipient = draft.editedRecipient || originalRecipient;
                    const proposalFieldIdBase = `proposal-${proposal.id}`;

                    return (
                      <div key={proposal.id} className="px-3 py-3 space-y-2">
                        {/* Agency label when multiple proposals visible */}
                        {currentTabProposals.length > 1 && proposal.agency_name && (
                          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                            {proposal.agency_name}
                          </div>
                        )}
                        {/* Action type + confidence */}
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={cn("text-[10px] px-1 py-0", ACTION_TYPE_LABELS[proposal.action_type]?.color || "")}>
                            {ACTION_TYPE_LABELS[proposal.action_type]?.label || proposal.action_type.replace(/_/g, " ")}
                          </Badge>
                          {typeof proposal.confidence === "number" && (
                            <span className="text-[10px] text-muted-foreground">{Math.round(proposal.confidence * 100)}%</span>
                          )}
                          {delivery && !isEmailLike && (
                            <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[200px]">
                              {delivery.method} → {delivery.target || "not set"}
                            </span>
                          )}
                        </div>

                        {/* Proposal content: email draft vs action card */}
                        {isEmailLike ? (
                          (proposal.draft_body_text || proposal.draft_subject) ? (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-muted-foreground font-medium shrink-0">To:</span>
                                <input
                                  id={`${proposalFieldIdBase}-recipient`}
                                  name={`${proposalFieldIdBase}-recipient`}
                                  className="flex-1 bg-background border border-border/50 rounded px-2 py-1 text-xs font-[inherit]"
                                  value={proposalRecipient}
                                  onChange={(e) => setDraft(proposal.id, { editedRecipient: e.target.value })}
                                  placeholder="recipient@agency.gov"
                                />
                              </div>
                              {(proposal.draft_subject || draft.editedSubject) && (
                                <input
                                  id={`${proposalFieldIdBase}-subject`}
                                  name={`${proposalFieldIdBase}-subject`}
                                  className="w-full bg-background border border-border/50 rounded px-2 py-1 text-xs font-[inherit]"
                                  value={draft.editedSubject}
                                  onChange={(e) => setDraft(proposal.id, { editedSubject: e.target.value })}
                                  placeholder="Subject"
                                />
                              )}
                              <textarea
                                id={`${proposalFieldIdBase}-body`}
                                name={`${proposalFieldIdBase}-body`}
                                className="w-full bg-background border border-border/50 rounded p-2 text-xs font-[inherit] leading-relaxed resize-y"
                                rows={8}
                                value={draft.editedBody}
                                onChange={(e) => setDraft(proposal.id, { editedBody: e.target.value })}
                              />
                              {(draft.editedBody !== (proposal.draft_body_text || "") || draft.editedSubject !== (proposal.draft_subject || "") || draft.editedRecipient !== originalRecipient) && (
                                <button
                                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                                  onClick={() => {
                                    let recipient = originalRecipient;
                                    if (proposal.case_agency_id != null) {
                                      const ag = _caseAgencies.find(ca => ca.id === proposal.case_agency_id);
                                      if (ag?.agency_email) recipient = ag.agency_email;
                                    }
                                    setDraft(proposal.id, {
                                      editedBody: proposal.draft_body_text || "",
                                      editedSubject: proposal.draft_subject || "",
                                      editedRecipient: recipient,
                                    });
                                  }}
                                >
                                  <RotateCcw className="h-2.5 w-2.5" /> Reset to AI draft
                                </button>
                              )}
                              {/* Prepared outbound attachments */}
                              {(() => {
                                const prepared = (request.attachments || []).filter((a: any) => a.direction === 'outbound');
                                if (prepared.length === 0) return null;
                                return (
                                  <div className="space-y-1">
                                    <p className="text-[10px] text-muted-foreground font-medium flex items-center gap-1">
                                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                                      Prepared Attachments
                                    </p>
                                    {prepared.map((att: any) => (
                                      <div key={att.id} className="flex items-center gap-1.5 text-xs">
                                        <a
                                          href={att.download_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="flex items-center gap-1.5 text-blue-400 hover:underline min-w-0"
                                        >
                                          <Paperclip className="h-3 w-3 flex-shrink-0 text-green-500" />
                                          <span className="truncate">{att.filename || `Attachment #${att.id}`}</span>
                                        </a>
                                        <button
                                          type="button"
                                          className="text-red-400 hover:text-red-300 p-0.5 flex-shrink-0"
                                          title="Delete attachment"
                                          onClick={async () => {
                                            if (!confirm(`Delete "${att.filename}"?`)) return;
                                            try {
                                              const res = await fetch(`/api/requests/${request.id}/attachments/${att.id}`, { method: 'DELETE' });
                                              if (!res.ok) throw new Error('Delete failed');
                                              mutate();
                                            } catch (err) {
                                              alert('Failed to delete attachment');
                                            }
                                          }}
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                );
                              })()}
                              <AttachmentPicker
                                attachments={draft.proposalAttachments}
                                onChange={(atts) => setDraft(proposal.id, { proposalAttachments: atts })}
                                disabled={isApproving}
                              />
                              {/* Chain follow-up */}
                              {proposal.action_chain && proposal.action_chain.length > 1 && (
                                <div className="border-t border-dashed pt-2 mt-2 space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-medium text-amber-400 uppercase tracking-wide flex items-center gap-1">
                                      <ArrowRight className="h-2.5 w-2.5" /> Then: {ACTION_TYPE_LABELS[proposal.action_chain[1].actionType]?.label || proposal.action_chain[1].actionType}
                                    </span>
                                    {(() => {
                                      const chainTarget = getDeliveryTarget(proposal.action_chain[1].actionType, request, agency_summary || null);
                                      return chainTarget ? (
                                        <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[200px]">
                                          {chainTarget.method} → {chainTarget.target || "not set"}
                                        </span>
                                      ) : null;
                                    })()}
                                  </div>
                                  {proposal.action_chain[1].draftSubject && (
                                    <input
                                      id={`${proposalFieldIdBase}-chain-subject`}
                                      name={`${proposalFieldIdBase}-chain-subject`}
                                      className="w-full bg-background border border-border/50 rounded px-2 py-1 text-xs"
                                      value={draft.editedChainSubject}
                                      onChange={(e) => setDraft(proposal.id, { editedChainSubject: e.target.value })}
                                      placeholder="Follow-up Subject"
                                    />
                                  )}
                                  <textarea
                                    id={`${proposalFieldIdBase}-chain-body`}
                                    name={`${proposalFieldIdBase}-chain-body`}
                                    className="w-full bg-background border border-border/50 rounded p-2 text-xs leading-relaxed resize-y"
                                    rows={4}
                                    value={draft.editedChainBody}
                                    onChange={(e) => setDraft(proposal.id, { editedChainBody: e.target.value })}
                                  />
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-[10px] text-muted-foreground">No draft. Approve to continue processing.</p>
                          )
                        ) : (
                          /* ── Non-email action: proposal card ── */
                          <div className={cn(
                            "rounded-md border p-3 space-y-2",
                            actionType === "SUBMIT_PORTAL" && "border-cyan-700/40 bg-cyan-500/5",
                            actionType === "RESEARCH_AGENCY" && "border-violet-700/40 bg-violet-500/5",
                            actionType === "CLOSE_CASE" && "border-gray-700/40 bg-muted/50",
                            actionType === "WITHDRAW" && "border-red-700/40 bg-red-500/5",
                            actionType === "ESCALATE" && "border-yellow-700/40 bg-yellow-500/5",
                            actionType === "REFORMULATE_REQUEST" && "border-fuchsia-700/40 bg-fuchsia-500/5",
                            !["SUBMIT_PORTAL", "RESEARCH_AGENCY", "CLOSE_CASE", "WITHDRAW", "ESCALATE", "REFORMULATE_REQUEST"].includes(actionType) && "border-border/60 bg-muted/30",
                          )}>
                            <div className="flex items-center gap-2">
                              {actionType === "SUBMIT_PORTAL" && <Globe className="h-4 w-4 text-cyan-400" />}
                              {actionType === "RESEARCH_AGENCY" && <Search className="h-4 w-4 text-violet-400" />}
                              {actionType === "CLOSE_CASE" && <CheckCircle className="h-4 w-4 text-gray-400" />}
                              {actionType === "WITHDRAW" && <XCircle className="h-4 w-4 text-red-400" />}
                              {actionType === "ESCALATE" && <AlertTriangle className="h-4 w-4 text-yellow-400" />}
                              {actionType === "REFORMULATE_REQUEST" && <RotateCcw className="h-4 w-4 text-fuchsia-400" />}
                              {!["SUBMIT_PORTAL", "RESEARCH_AGENCY", "CLOSE_CASE", "WITHDRAW", "ESCALATE", "REFORMULATE_REQUEST"].includes(actionType) && <Bot className="h-4 w-4 text-muted-foreground" />}
                              <span className="text-xs font-medium">
                                {ACTION_TYPE_LABELS[actionType]?.label || actionType.replace(/_/g, " ")}
                              </span>
                            </div>
                            {proposal.draft_body_text && (
                              <LinkifiedText text={proposal.draft_body_text || ""} className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed" />
                            )}
                            {!proposal.draft_body_text && manualPdfEscalation && (
                              <div className="rounded border border-amber-700/40 bg-amber-500/10 px-2 py-2 text-xs text-amber-200 space-y-1">
                                <p>{manualPdfEscalation.instruction}</p>
                                {delivery?.target && (
                                  <p>
                                    <span className="text-amber-100/80">Send to:</span>{" "}
                                    <span className="font-medium">{delivery.target}</span>
                                  </p>
                                )}
                                {manualPdfEscalation.failureReason && (
                                  <p className="text-amber-100/80">
                                    Failure: {manualPdfEscalation.failureReason}
                                  </p>
                                )}
                              </div>
                            )}
                            {!proposal.draft_body_text && !manualPdfEscalation && (
                              <p className="text-[10px] text-muted-foreground italic">Approve to proceed with this action.</p>
                            )}
                          </div>
                        )}

                        {/* Reasoning (collapsible) */}
                        {Array.isArray(proposal.reasoning) && proposal.reasoning.length > 0 && (
                          <details className="text-xs">
                            <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">Reasoning</summary>
                            <ul className="mt-1 space-y-0.5 text-muted-foreground">
                              {formatReasoning(proposal.reasoning, 5).map((r, i) => (
                                <li key={i} className="flex gap-1"><span className="text-blue-400 shrink-0">-</span><span>{r}</span></li>
                              ))}
                            </ul>
                          </details>
                        )}

                        {/* Manual portal submission helper — per-field copy UI */}
                        {portal_helper && ["SUBMIT_PORTAL", "ESCALATE"].includes(proposal.action_type) && (() => {
                          const CopyRow = ({ label, value, fieldKey }: { label: string; value: string | null | undefined; fieldKey: string }) => {
                            if (!value) return null;
                            return (
                              <div className="flex items-center justify-between gap-2 py-0.5">
                                <div className="min-w-0">
                                  <span className="text-muted-foreground">{label}: </span>
                                  <span className="text-foreground">{value}</span>
                                </div>
                                <Button
                                  size="sm" variant="ghost"
                                  className="h-5 px-1.5 text-[10px] shrink-0"
                                  onClick={() => copyField(fieldKey, value)}
                                >
                                  {copiedField === fieldKey ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                                </Button>
                              </div>
                            );
                          };
                          return (
                            <div className="rounded-md border border-cyan-800/40 bg-cyan-950/20 p-3 space-y-3 text-xs">
                              <div className="flex items-center gap-2">
                                <Globe className="h-4 w-4 text-cyan-400" />
                                <span className="font-medium text-cyan-300">Manual Portal Submission</span>
                              </div>

                              {portal_helper.portal_url && (
                                <Button
                                  size="sm"
                                  className="bg-cyan-700 hover:bg-cyan-600 text-white h-7 text-xs"
                                  onClick={() => window.open(portal_helper.portal_url!, "_blank")}
                                >
                                  <ExternalLink className="h-3 w-3 mr-1.5" /> Open Portal
                                </Button>
                              )}

                              <div className="space-y-0.5">
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Requester</p>
                                <CopyRow label="Name" value={portal_helper.requester.name} fieldKey="ph-name" />
                                <CopyRow label="Email" value={portal_helper.requester.email} fieldKey="ph-email" />
                                <CopyRow label="Phone" value={portal_helper.requester.phone} fieldKey="ph-phone" />
                                <CopyRow label="Organization" value={portal_helper.requester.organization} fieldKey="ph-org" />
                              </div>

                              <div className="space-y-0.5">
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Address</p>
                                <CopyRow label="Street" value={portal_helper.address.line1} fieldKey="ph-street" />
                                {portal_helper.address.line2 && <CopyRow label="Line 2" value={portal_helper.address.line2} fieldKey="ph-line2" />}
                                <CopyRow label="City" value={portal_helper.address.city} fieldKey="ph-city" />
                                <CopyRow label="State" value={portal_helper.address.state} fieldKey="ph-state" />
                                <CopyRow label="ZIP" value={portal_helper.address.zip} fieldKey="ph-zip" />
                              </div>

                              <div className="space-y-0.5">
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Case Info</p>
                                <CopyRow label="Subject" value={portal_helper.case_info.subject_name} fieldKey="ph-subject" />
                                <CopyRow label="Incident Date" value={portal_helper.case_info.incident_date} fieldKey="ph-date" />
                                {portal_helper.case_info.requested_records.length > 0 && (
                                  <CopyRow label="Records" value={portal_helper.case_info.requested_records.join(", ")} fieldKey="ph-records" />
                                )}
                                <CopyRow label="Details" value={portal_helper.case_info.additional_details} fieldKey="ph-details" />
                              </div>

                              <div className="flex items-center gap-2 pt-1">
                                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => {
                                  const lines = [
                                    `Name: ${portal_helper.requester.name}`,
                                    `Email: ${portal_helper.requester.email}`,
                                    `Phone: ${portal_helper.requester.phone}`,
                                    portal_helper.requester.organization && `Organization: ${portal_helper.requester.organization}`,
                                    `Address: ${portal_helper.address.line1}, ${portal_helper.address.city}, ${portal_helper.address.state} ${portal_helper.address.zip}`,
                                    portal_helper.case_info.subject_name && `Subject: ${portal_helper.case_info.subject_name}`,
                                    portal_helper.case_info.incident_date && `Date: ${portal_helper.case_info.incident_date}`,
                                    portal_helper.case_info.requested_records.length > 0 && `Records: ${portal_helper.case_info.requested_records.join(", ")}`,
                                    portal_helper.case_info.additional_details && `Details: ${portal_helper.case_info.additional_details}`,
                                  ].filter(Boolean).join("\n");
                                  navigator.clipboard.writeText(lines);
                                  toast.success("All fields copied");
                                }}>
                                  <Copy className="h-3 w-3 mr-1" /> Copy All
                                </Button>
                                <Button
                                  size="sm"
                                  className="bg-green-700 hover:bg-green-600 text-white h-7 text-xs"
                                  onClick={() => handleManualSubmit(proposal.id)}
                                  disabled={isManualSubmitting}
                                >
                                  {isManualSubmitting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CheckCircle className="h-3 w-3 mr-1" />}
                                  Mark Submitted
                                </Button>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Action buttons */}
                        <div className="flex items-center gap-2 pt-1">
                          {isThisProposalApplying ? (
                            <div className="flex items-center gap-2 text-xs text-blue-300 rounded border border-blue-700/50 bg-blue-500/10 px-2 py-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Applying decision...
                            </div>
                          ) : (() => {
                            const gateOptions = proposal.gate_options as string[] | null;
                            const showApprove = (!gateOptions || gateOptions.includes("APPROVE")) && !manualPdfEscalation;
                            const showAdjust = !gateOptions || gateOptions.includes("ADJUST");
                            const showDismiss = !gateOptions || gateOptions.includes("DISMISS");
                            const showRetryResearch = gateOptions?.includes("RETRY_RESEARCH");
                            const showAddToInvoicing = gateOptions?.includes("ADD_TO_INVOICING");
                            const showWaitForGoodToPay = gateOptions?.includes("WAIT_FOR_GOOD_TO_PAY");
                            return (
                              <>
                                {showRetryResearch && (
                                  <Button size="sm" className="h-7 text-xs bg-amber-700 hover:bg-amber-600" onClick={() => handleRetryResearch(proposal.id)} disabled={isApproving || isAdjustingPending}>
                                    {isApproving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                                    Retry Research
                                  </Button>
                                )}
                                {showApprove && (
                                  <Button size="sm" className="h-7 text-xs bg-green-700 hover:bg-green-600" onClick={() => handleApprovePending(proposal.id)} disabled={isApproving || isAdjustingPending}>
                                    {isApproving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : isEmailLike ? <Send className="h-3 w-3 mr-1" /> : <CheckCircle className="h-3 w-3 mr-1" />}
                                    {approveLabel}
                                  </Button>
                                )}
                                {showAdjust && (
                                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setPendingAdjustProposalId(proposal.id); setPendingAdjustModalOpen(true); }} disabled={isApproving || isAdjustingPending}>
                                    <Edit className="h-3 w-3 mr-1" /> Adjust
                                  </Button>
                                )}
                                {showAddToInvoicing && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={() => handleFeeWorkflowDecision(proposal.id, "ADD_TO_INVOICING")}
                                    disabled={isApproving || isAdjustingPending}
                                  >
                                    <DollarSign className="h-3 w-3 mr-1" /> Add to Invoicing
                                  </Button>
                                )}
                                {showWaitForGoodToPay && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    onClick={() => handleFeeWorkflowDecision(proposal.id, "WAIT_FOR_GOOD_TO_PAY")}
                                    disabled={isApproving || isAdjustingPending}
                                  >
                                    <Clock className="h-3 w-3 mr-1" /> Wait for Good to Pay
                                  </Button>
                                )}
                                {showDismiss && (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={isApproving || isAdjustingPending}>
                                        <Trash2 className="h-3 w-3 mr-1" /> Dismiss <ChevronDown className="h-2.5 w-2.5 ml-1" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="start">
                                      {DISMISS_REASONS.map((reason) => (
                                        <DropdownMenuItem key={reason} onClick={() => handleDismissPending(proposal.id, reason)} className="text-xs">{reason}</DropdownMenuItem>
                                      ))}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  });
                })()}
                {_pendingProposals.length > 0 ? null : isPaused ? (
                  <div className="px-3 py-3">
                    <DecisionPanel
                      request={request}
                      nextAction={nextAction}
                      agency={agency_summary}
                      lastInboundMessage={lastInboundMessage}
                      reviewState={review_state}
                      onProceed={handleProceed}
                      onNegotiate={() => handleRevise("Draft a fee negotiation email proposing to narrow the scope to reduce cost.")}
                      onCustomAdjust={() => setAdjustModalOpen(true)}
                      onWithdraw={() => setWithdrawDialogOpen(true)}
                      onNarrowScope={() => handleRevise("Draft a response narrowing the scope of the request.")}
                      onAppeal={() => handleRevise("Draft an administrative appeal of the denial.")}
                      onMakePhoneCall={handleMakePhoneCall}
                      onAddToPhoneQueue={handleAddToPhoneQueue}
                      onResolveReview={handleResolveReview}
                      onRepair={handleResetToLastInbound}
                      isLoading={isApproving || isRevising || isResolving}
                    />
                  </div>
                ) : staleReviewStatus ? (
                  <div className="px-3 py-3">
                    <div className="rounded border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                      Case status was stale and no active proposal is available. Reprocessing will generate the next proposal if needed.
                    </div>
                    <div className="mt-2">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleInvokeAgent} disabled={isInvokingAgent}>
                        {isInvokingAgent ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                        Re-process Case
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="px-3 py-3">
                    <Composer
                      onSend={handleSendMessage}
                      extraActions={
                        <Button variant="outline" onClick={() => setGuideModalOpen(true)}>
                          <Bot className="h-4 w-4 mr-1" /> Guide AI
                        </Button>
                      }
                    />
                  </div>
                )}
              </div>
            </div>
          ) : activeView === "case-info" ? (
            /* ── CASE INFO VIEW ────────────────────────────────────────────── */
            <ScrollArea className="flex-1 h-0">
              <div className="p-3">
                <CaseInfoTab
                  caseId={id!}
                  request={request}
                  agencySummary={agency_summary}
                  caseAgencies={case_agencies}
                  onContactsUpdated={() => mutate()}
                  deadlineMilestones={deadline_milestones}
                  stateDeadline={state_deadline}
                  threadMessages={_threadMessages}
                />
              </div>
            </ScrollArea>
          ) : activeView === "agency" ? (
            /* ── AGENCY VIEW ───────────────────────────────────────────────── */
            <ScrollArea className="flex-1 h-0">
              <div className="p-3 space-y-4">
                {/* CopilotPanel */}
                <CopilotPanel
                  request={request}
                  nextAction={nextAction}
                  agency={agency_summary}
                  onChallenge={() => setAdjustModalOpen(true)}
                  onRefresh={mutate}
                />

                {/* Case Agencies */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Case Agencies ({_activeCaseAgencies.length})</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Add Agency form */}
                    <div className="space-y-2 rounded border border-dashed border-border/60 p-2">
                      <Input
                        id="manual-agency-name"
                        name="manual-agency-name"
                        placeholder="Agency name"
                        value={manualAgencyName}
                        onChange={(e) => setManualAgencyName(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <Input
                        id="manual-agency-email"
                        name="manual-agency-email"
                        placeholder="Email (optional)"
                        value={manualAgencyEmail}
                        onChange={(e) => setManualAgencyEmail(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <Input
                        id="manual-agency-portal-url"
                        name="manual-agency-portal-url"
                        placeholder="Portal URL (optional)"
                        value={manualAgencyPortalUrl}
                        onChange={(e) => setManualAgencyPortalUrl(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="h-7 text-xs flex-1" onClick={() => handleAddManualAgency(false)} disabled={isManualAgencySubmitting || !manualAgencyName.trim()}>
                          {isManualAgencySubmitting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                          Add Agency
                        </Button>
                        <Button size="sm" className="h-7 text-xs flex-1" onClick={() => handleAddManualAgency(true)} disabled={isManualAgencySubmitting || !manualAgencyName.trim()}>
                          {isManualAgencySubmitting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
                          Add & Start
                        </Button>
                      </div>
                    </div>

                    {/* Agency list */}
                    {_activeCaseAgencies.map((ca) => {
                      const stats = agencyMessageStats.get(ca.id);
                      const isSettingPrimary =
                        agencyActionLoading?.id === ca.id &&
                        agencyActionLoading.action === "primary";
                      const isResearchingAgency =
                        agencyActionLoading?.id === ca.id &&
                        agencyActionLoading.action === "research";
                      const isConfirmingPortal =
                        agencyActionLoading?.id === ca.id &&
                        agencyActionLoading.action === "confirm-portal";
                      const isBlockingPortal =
                        agencyActionLoading?.id === ca.id &&
                        agencyActionLoading.action === "block-portal";
                      const isValidatingPortal =
                        agencyActionLoading?.id === ca.id &&
                        agencyActionLoading.action === "validate-portal";
                      const portalAutomationLabel =
                        ca.portal_automation_status === "trusted"
                          ? "Trusted portal"
                          : ca.portal_automation_status === "auto_supported"
                            ? "Auto-supported portal"
                            : ca.portal_automation_status === "blocked"
                              ? "Manual-only portal"
                              : ca.portal_automation_status === "needs_confirmation"
                                ? "Portal needs confirmation"
                                : ca.portal_automation_status === "invalid"
                                  ? "Invalid portal"
                                  : null;
                      const isEditing = editingAgencyId === ca.id;
                      return (
                        <div key={ca.id} className="rounded border p-3 space-y-1.5">
                          <div className="flex items-center gap-2">
                            {isEditing ? (
                              <Input value={editAgencyFields.agency_name ?? ca.agency_name ?? ""} onChange={(e) => setEditAgencyFields((f) => ({ ...f, agency_name: e.target.value }))} className="h-6 text-xs flex-1" placeholder="Agency name" />
                            ) : (
                              <span className="text-xs font-medium">{ca.agency_name || "Unnamed"}</span>
                            )}
                            {ca.is_primary && <Badge variant="secondary" className="text-[10px] px-1">Primary</Badge>}
                          </div>
                          {isEditing ? (
                            <div className="space-y-1">
                              <Input value={editAgencyFields.agency_email ?? ca.agency_email ?? ""} onChange={(e) => setEditAgencyFields((f) => ({ ...f, agency_email: e.target.value }))} className="h-6 text-xs" placeholder="Email" />
                              <Input value={editAgencyFields.portal_url ?? ca.portal_url ?? ""} onChange={(e) => setEditAgencyFields((f) => ({ ...f, portal_url: e.target.value }))} className="h-6 text-xs" placeholder="Portal URL" />
                            </div>
                          ) : (
                            <>
                              {ca.agency_email && (
                                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <Mail className="h-2.5 w-2.5" />
                                  <span className="truncate">{ca.agency_email}</span>
                                </div>
                              )}
                              {ca.portal_url && (
                                <div className="flex items-center gap-1 text-[10px]">
                                  <Globe className="h-2.5 w-2.5 text-muted-foreground" />
                                  <a href={ca.portal_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">Portal</a>
                                </div>
                              )}
                            </>
                          )}
                          {ca.manual_request_url && (
                            <div className="flex items-center gap-1 text-[10px]">
                              <ExternalLink className="h-2.5 w-2.5 text-muted-foreground" />
                              <a href={ca.manual_request_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">Manual page</a>
                            </div>
                          )}
                          {ca.pdf_form_url && (
                            <div className="flex items-center gap-1 text-[10px]">
                              <FileText className="h-2.5 w-2.5 text-muted-foreground" />
                              <a href={ca.pdf_form_url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">PDF form</a>
                            </div>
                          )}
                          {portalAutomationLabel && (
                            <div className="flex flex-wrap items-center gap-1 text-[10px]">
                              <Badge
                                variant={ca.portal_automation_status === "blocked" || ca.portal_automation_status === "invalid" ? "destructive" : "outline"}
                                className="text-[10px] px-1 py-0"
                              >
                                {portalAutomationLabel}
                              </Badge>
                              {ca.portal_automation_reason && (
                                <span className="text-muted-foreground">
                                  {ca.portal_automation_reason.replace(/_/g, " ")}
                                </span>
                              )}
                            </div>
                          )}
                          {(ca.portal_automation_last_validation_status || ca.portal_automation_last_validated_at) && (
                            <div className="space-y-1 rounded border border-dashed p-2 text-[10px] text-muted-foreground">
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="font-medium text-foreground">Last browser validation</span>
                                {ca.portal_automation_last_validation_status && (
                                  <Badge variant="outline" className="text-[10px] px-1 py-0">
                                    {ca.portal_automation_last_validation_status.replace(/_/g, " ")}
                                  </Badge>
                                )}
                                {ca.portal_automation_last_validation_page_kind && (
                                  <span>{ca.portal_automation_last_validation_page_kind.replace(/_/g, " ")}</span>
                                )}
                                {ca.portal_automation_last_validated_at && (
                                  <span>· {formatRelativeTime(ca.portal_automation_last_validated_at)}</span>
                                )}
                              </div>
                              {ca.portal_automation_last_validation_title && (
                                <div className="truncate">{ca.portal_automation_last_validation_title}</div>
                              )}
                              <div className="flex flex-wrap items-center gap-2">
                                {ca.portal_automation_last_validation_url && (
                                  <a
                                    href={ca.portal_automation_last_validation_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-400 hover:underline"
                                  >
                                    Observed URL
                                  </a>
                                )}
                                {ca.portal_automation_last_validation_session_url && (
                                  <a
                                    href={ca.portal_automation_last_validation_session_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-400 hover:underline"
                                  >
                                    Browser session
                                  </a>
                                )}
                              </div>
                              {ca.portal_automation_last_validation_screenshot_url && (
                                <a
                                  href={ca.portal_automation_last_validation_screenshot_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block overflow-hidden rounded border"
                                >
                                  <img
                                    src={ca.portal_automation_last_validation_screenshot_url}
                                    alt={`Portal validation screenshot for ${ca.agency_name}`}
                                    className="max-h-40 w-full object-cover"
                                  />
                                </a>
                              )}
                            </div>
                          )}
                          {stats && (stats.total > 0 || stats.recordedSubmissionAt) && (
                            <div className="text-[10px] text-muted-foreground">
                              {stats.total > 0
                                ? `${stats.total} messages (${stats.outbound} sent, ${stats.inbound} received)`
                                : "No email thread recorded"}
                              {stats.recordedSubmissionAt && (
                                <span>
                                  {stats.total > 0 ? " · " : " · "}
                                  {stats.outbound > 0 ? "request submitted" : "1 portal/manual submission"}
                                  {" "}
                                  {formatRelativeTime(stats.recordedSubmissionAt)}
                                </span>
                              )}
                              {stats.lastMessageAt && <span> · Last: {formatRelativeTime(stats.lastMessageAt)}</span>}
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                            {isEditing ? (
                              <>
                                <Button size="sm" className="h-6 text-[10px]" onClick={async () => {
                                  try {
                                    await fetchAPI(`/cases/${request.id}/agencies/${ca.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editAgencyFields) });
                                    setEditingAgencyId(null);
                                    setEditAgencyFields({});
                                    mutate();
                                  } catch (e: any) { alert(e.message || "Save failed"); }
                                }}>Save</Button>
                                <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => { setEditingAgencyId(null); setEditAgencyFields({}); }}>Cancel</Button>
                              </>
                            ) : (
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => { setEditingAgencyId(ca.id); setEditAgencyFields({ agency_name: ca.agency_name, agency_email: ca.agency_email, portal_url: ca.portal_url }); }}>
                                Edit
                              </Button>
                            )}
                            {!ca.is_primary && !isEditing && (
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleSetPrimaryAgency(ca.id)} disabled={agencyActionLoading?.id === ca.id}>
                                {isSettingPrimary ? (
                                  <>
                                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                                    Setting...
                                  </>
                                ) : (
                                  "Set Primary"
                                )}
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleResearchAgency(ca.id)} disabled={agencyActionLoading?.id === ca.id}>
                              {isResearchingAgency ? (
                                <>
                                  <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                                  Researching...
                                </>
                              ) : (
                                "Research"
                              )}
                            </Button>
                            {ca.portal_url && ca.portal_automation_status !== "trusted" && (
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleConfirmPortal(ca.id)} disabled={agencyActionLoading?.id === ca.id}>
                                {isConfirmingPortal ? (
                                  <>
                                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                                    Confirming...
                                  </>
                                ) : (
                                  "Confirm Portal"
                                )}
                              </Button>
                            )}
                            {ca.portal_url && ca.portal_automation_status === "needs_confirmation" && (
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleValidatePortal(ca.id)} disabled={agencyActionLoading?.id === ca.id}>
                                {isValidatingPortal ? (
                                  <>
                                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                                    Validating...
                                  </>
                                ) : (
                                  <>
                                    <Search className="h-2.5 w-2.5 mr-1" />
                                    Validate in Browser
                                  </>
                                )}
                              </Button>
                            )}
                            {ca.portal_url && ca.portal_automation_status !== "blocked" && (
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleBlockPortal(ca.id)} disabled={agencyActionLoading?.id === ca.id}>
                                {isBlockingPortal ? (
                                  <>
                                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                                    Saving...
                                  </>
                                ) : (
                                  "Mark Manual"
                                )}
                              </Button>
                            )}
                            {!isEditing && (
                              <Button size="sm" className="h-6 text-[10px]" onClick={() => handleStartRequestForAgency(ca.id)} disabled={agencyStartLoadingId === ca.id}>
                                {agencyStartLoadingId === ca.id ? <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" /> : <Play className="h-2.5 w-2.5 mr-1" />}
                                Start Request
                              </Button>
                            )}
                            {!ca.is_primary && !isEditing && (
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] text-destructive hover:text-destructive" onClick={() => handleRemoveAgency(ca.id, ca.agency_name || "agency")} disabled={agencyActionLoading?.id === ca.id}>
                                {agencyActionLoading?.id === ca.id && agencyActionLoading.action === "remove" ? (
                                  <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                                ) : (
                                  <Trash2 className="h-2.5 w-2.5 mr-1" />
                                )}
                                Remove
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                {/* Research Candidates */}
                {agency_candidates.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Research Candidates</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {agency_candidates.map((candidate: AgencyCandidate, idx: number) => (
                        <div key={`${candidate.name || "candidate"}-${idx}`} className="rounded border p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-xs font-medium">{candidate.name || "Unnamed agency"}</p>
                              <p className="text-[10px] text-muted-foreground">
                                {candidate.agency_email || "No email"} {candidate.portal_url ? "· Portal found" : ""}
                              </p>
                              {candidate.reason && (
                                <p className="text-[10px] text-muted-foreground mt-1">{candidate.reason}</p>
                              )}
                              <div className="mt-1.5 flex gap-1.5 flex-wrap">
                                {candidate.source && <Badge variant="outline" className="text-[10px]">{candidate.source}</Badge>}
                                {typeof candidate.confidence === "number" && (
                                  <Badge variant="outline" className="text-[10px]">{Math.round(candidate.confidence * 100)}%</Badge>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-1.5 shrink-0">
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleAddCandidateAgency(candidate)}>
                                {candidateActionLoadingName === candidate.name ? "Adding..." : "Add"}
                              </Button>
                              <Button size="sm" className="h-6 text-[10px]" onClick={() => handleAddCandidateAgency(candidate, true)}>
                                {candidateStartLoadingName === candidate.name ? "Starting..." : "Add & Start"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </div>
            </ScrollArea>
          ) : activeView === "intel" ? (
            /* ── INTEL VIEW (mobile only — mirrors sidebar content) ───────── */
            <ScrollArea className="flex-1 h-0">
              {portalTaskActive && (
                <CollapsibleSection title="PORTAL LIVE">
                  <PortalLiveView
                    caseId={id!}
                    initialScreenshotUrl={request.last_portal_screenshot_url}
                    portalTaskUrl={request.last_portal_task_url}
                  />
                </CollapsibleSection>
              )}
              <CollapsibleSection title="AGENCY">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium">{agency_summary?.name || request.agency_name}</div>
                    {agency_summary?.id && /^\d+$/.test(String(agency_summary.id)) && (
                      <a href={`/agencies/detail?id=${agency_summary.id}`} className="text-[10px] text-primary hover:underline flex items-center gap-0.5">
                        <ExternalLink className="h-2.5 w-2.5" /> Profile
                      </a>
                    )}
                  </div>
                  {request.state && <span className="text-[10px] text-muted-foreground">{request.state}</span>}
                  {request.agency_email && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Mail className="h-2.5 w-2.5" />
                      <span className="truncate">{request.agency_email}</span>
                    </div>
                  )}
                  {(() => {
                    const portalUrl = resolvePortalUrl(request.portal_url, agency_summary?.portal_url ?? null);
                    const manualRequestUrl = resolveManualRequestUrl(request.manual_request_url, null);
                    const pdfFormUrl = resolvePdfFormUrl(request.pdf_form_url, null);
                    return (
                      <>
                        {portalUrl && (
                          <div className="flex items-center gap-1 text-[10px]">
                            <Globe className="h-2.5 w-2.5 text-muted-foreground" />
                            <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">
                              {request.portal_provider || agency_summary?.portal_provider || "Portal"}
                            </a>
                          </div>
                        )}
                        {manualRequestUrl && (
                          <div className="flex items-center gap-1 text-[10px]">
                            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground" />
                            <a href={manualRequestUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">
                              Manual request page
                            </a>
                          </div>
                        )}
                        {pdfFormUrl && (
                          <div className="flex items-center gap-1 text-[10px]">
                            <FileText className="h-2.5 w-2.5 text-muted-foreground" />
                            <a href={pdfFormUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate">
                              PDF / request form
                            </a>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {agency_summary?.submission_method && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">{agency_summary.submission_method}</Badge>
                  )}
                  {agency_summary?.id && /^\d+$/.test(String(agency_summary.id)) && (
                    <AgencyStatsBar agencyId={agency_summary.id} />
                  )}
                </div>
              </CollapsibleSection>
              {((request.fee_quote && request.fee_quote.amount > 0) || (request.cost_amount != null && request.cost_amount > 0)) && (
                <CollapsibleSection title="FEES">
                  {request.fee_quote && request.fee_quote.amount > 0 ? (
                    <FeeBreakdown feeQuote={request.fee_quote} scopeItems={request.scope_items} className="border-0 bg-transparent p-0 shadow-none" />
                  ) : (
                    <div className="text-[10px] text-muted-foreground">{formatCurrency(request.cost_amount!)}</div>
                  )}
                </CollapsibleSection>
              )}
              {deadline_milestones && deadline_milestones.length > 0 && (
                <CollapsibleSection title="DEADLINE">
                  <DeadlineCalculator milestones={deadline_milestones} stateDeadline={state_deadline} compact />
                </CollapsibleSection>
              )}
              <CollapsibleSection
                title="CONSTRAINTS"
                count={request.constraints?.length || 0}
                action={
                  <button
                    onClick={(e) => { e.stopPropagation(); setConstraintEditing(!constraintEditing); }}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {constraintEditing ? "Done" : "Edit"}
                  </button>
                }
              >
                <ConstraintsDisplay
                  constraints={request.constraints || []}
                  editable={constraintEditing}
                  onRemove={handleRemoveConstraint}
                  onAdd={() => setAddConstraintOpen(true)}
                  history={constraintHistory}
                />
              </CollapsibleSection>
              {request.constraints && request.constraints.some((c: any) => c.type === "EXEMPTION") && (
                <CollapsibleSection title="EXEMPTION CLAIMS" defaultOpen={false}>
                  <ExemptionClaimsList
                    constraints={request.constraints}
                    state={request.state || ""}
                    requestId={String(request.id)}
                    onChallenge={() => setAdjustModalOpen(true)}
                  />
                </CollapsibleSection>
              )}
              {timeline_events.length > 0 && (
                <CollapsibleSection title="TIMELINE" count={timeline_events.length}>
                  <Timeline events={timeline_events.slice(0, 20)} compact />
                </CollapsibleSection>
              )}
              <ProposalHistorySection caseId={id!} />
              <DecisionTracesSection caseId={id!} />
              <EventLedgerSection caseId={id!} />
              <PortalSubmissionsSection caseId={id!} />
              <ProviderPayloadsSection caseId={id!} />
              {hasPortalHistory && (
                <CollapsibleSection title="PORTAL SCREENSHOTS" defaultOpen={false}>
                  <PortalLiveView caseId={id!} portalTaskUrl={request.last_portal_task_url} isLive={false} />
                </CollapsibleSection>
              )}
            </ScrollArea>
          ) : activeView === "timeline" ? (
            /* ── TIMELINE VIEW — full chronological case activity ──────────── */
            <div className="flex-1 min-h-0 p-3">
              <Timeline events={timeline_events} />
            </div>
          ) : null}
        </div>

        {/* ── RESIZE HANDLE ────────────────────────────────────────────────── */}
        <div
          className="hidden md:flex shrink-0 w-1.5 cursor-col-resize items-center justify-center hover:bg-primary/20 active:bg-primary/30 transition-colors group"
          onMouseDown={handleSidebarDragStart}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground" />
        </div>

        {/* ── RIGHT PANEL: Intel Sidebar (desktop only, mobile uses Intel tab) ── */}
        <div style={{ width: sidebarWidth }} className="hidden md:flex shrink-0 flex-col min-h-0">
          <ScrollArea className="flex-1 h-0">
              {/* Portal overlay */}
              {portalTaskActive && (
                <CollapsibleSection title="PORTAL LIVE">
                  <PortalLiveView
                    caseId={id!}
                    initialScreenshotUrl={request.last_portal_screenshot_url}
                    portalTaskUrl={request.last_portal_task_url}
                  />
                </CollapsibleSection>
              )}

              {/* AGENCY */}
              <CollapsibleSection title="AGENCY">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium">{agency_summary?.name || request.agency_name}</div>
                    {agency_summary?.id && /^\d+$/.test(String(agency_summary.id)) && (
                      <a href={`/agencies/detail?id=${agency_summary.id}`} className="text-[10px] text-primary hover:underline flex items-center gap-0.5">
                        <ExternalLink className="h-2.5 w-2.5" /> Profile
                      </a>
                    )}
                  </div>
                  {request.state && <span className="text-[10px] text-muted-foreground">{request.state}</span>}
                  {request.agency_email && (
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Mail className="h-2.5 w-2.5" />
                      <span className="truncate">{request.agency_email}</span>
                    </div>
                  )}
                  {(() => {
                    const portalUrl = resolvePortalUrl(request.portal_url, agency_summary?.portal_url ?? null);
                    const manualRequestUrl = resolveManualRequestUrl(request.manual_request_url, null);
                    const pdfFormUrl = resolvePdfFormUrl(request.pdf_form_url, null);
                    return (
                      <>
                        {portalUrl && (
                          <div className="flex items-center gap-1 text-[10px]">
                            <Globe className="h-2.5 w-2.5 text-muted-foreground" />
                            <a
                              href={portalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:underline truncate"
                            >
                              {request.portal_provider || agency_summary?.portal_provider || "Portal"}
                            </a>
                          </div>
                        )}
                        {manualRequestUrl && (
                          <div className="flex items-center gap-1 text-[10px]">
                            <ExternalLink className="h-2.5 w-2.5 text-muted-foreground" />
                            <a
                              href={manualRequestUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:underline truncate"
                            >
                              Manual request page
                            </a>
                          </div>
                        )}
                        {pdfFormUrl && (
                          <div className="flex items-center gap-1 text-[10px]">
                            <FileText className="h-2.5 w-2.5 text-muted-foreground" />
                            <a
                              href={pdfFormUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:underline truncate"
                            >
                              PDF / request form
                            </a>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {agency_summary?.submission_method && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      {agency_summary.submission_method}
                    </Badge>
                  )}
                  {agency_summary?.rules && (
                    <div className="text-[10px] space-y-1 pt-1 border-t border-border/30">
                      {agency_summary.rules.fee_auto_approve_threshold !== null && agency_summary.rules.fee_auto_approve_threshold !== undefined && (
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>Auto-approve fees under</span>
                          <span className="font-medium text-foreground">{formatCurrency(agency_summary.rules.fee_auto_approve_threshold)}</span>
                        </div>
                      )}
                      {agency_summary.rules.always_human_gates && agency_summary.rules.always_human_gates.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="text-muted-foreground">Always-human:</span>
                          {agency_summary.rules.always_human_gates.map((g: string, i: number) => (
                            <Badge key={i} variant="secondary" className="text-[10px]">{g}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {agency_summary?.id && /^\d+$/.test(String(agency_summary.id)) && (
                    <AgencyStatsBar agencyId={agency_summary.id} />
                  )}
                </div>
              </CollapsibleSection>

              {/* FEES */}
              {((request.fee_quote && request.fee_quote.amount > 0) || (request.cost_amount != null && request.cost_amount > 0)) && (
                <CollapsibleSection title="FEES">
                  {request.fee_quote && request.fee_quote.amount > 0 ? (
                    <FeeBreakdown feeQuote={request.fee_quote} scopeItems={request.scope_items} className="border-0 bg-transparent p-0 shadow-none" />
                  ) : (
                    <div className="text-[10px] text-muted-foreground">
                      {formatCurrency(request.cost_amount!)}
                    </div>
                  )}
                </CollapsibleSection>
              )}

              {/* DEADLINE */}
              {deadline_milestones && deadline_milestones.length > 0 && (
                <CollapsibleSection title="DEADLINE">
                  <DeadlineCalculator
                    milestones={deadline_milestones}
                    stateDeadline={state_deadline}
                    compact
                  />
                </CollapsibleSection>
              )}

              {/* CONSTRAINTS */}
              <CollapsibleSection
                title="CONSTRAINTS"
                count={request.constraints?.length || 0}
                action={
                  <button
                    onClick={(e) => { e.stopPropagation(); setConstraintEditing(!constraintEditing); }}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {constraintEditing ? "Done" : "Edit"}
                  </button>
                }
              >
                <ConstraintsDisplay
                  constraints={request.constraints || []}
                  editable={constraintEditing}
                  onRemove={handleRemoveConstraint}
                  onAdd={() => setAddConstraintOpen(true)}
                  history={constraintHistory}
                />
              </CollapsibleSection>

              {/* EXEMPTION CLAIMS */}
              {request.constraints && request.constraints.some((c: any) => c.type === "EXEMPTION") && (
                <CollapsibleSection title="EXEMPTION CLAIMS" defaultOpen={false}>
                  <ExemptionClaimsList
                    constraints={request.constraints}
                    state={request.state || ""}
                    requestId={String(request.id)}
                    onChallenge={(instruction) => {
                      setAdjustModalOpen(true);
                    }}
                  />
                </CollapsibleSection>
              )}

              {/* TIMELINE */}
              {timeline_events.length > 0 && (
                <CollapsibleSection title="TIMELINE" count={timeline_events.length}>
                  <Timeline events={timeline_events.slice(0, 20)} compact />
                </CollapsibleSection>
              )}

              {/* DECISION TRACES */}
              <DecisionTracesSection caseId={id!} />

              {/* EVENT LEDGER */}
              <EventLedgerSection caseId={id!} />

              {/* PORTAL SUBMISSIONS */}
              <PortalSubmissionsSection caseId={id!} />

              {/* PROVIDER PAYLOADS */}
              <ProviderPayloadsSection caseId={id!} />

              {/* Portal history */}
              {hasPortalHistory && (
                <CollapsibleSection title="PORTAL SCREENSHOTS" defaultOpen={false}>
                  <PortalLiveView
                    caseId={id!}
                    portalTaskUrl={request.last_portal_task_url}
                    isLive={false}
                  />
                </CollapsibleSection>
              )}
            </ScrollArea>
        </div>
      </div>

      {/* ── BOTTOM TAB BAR ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border/50">
        <div className="flex h-8 items-center gap-0 overflow-x-auto whitespace-nowrap px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Main view tabs */}
          {(["thread", "case-info", "agency", "timeline"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (activeView === tab) setActiveView("thread");
                else { setActiveView(tab); setBottomDrawer(null); }
              }}
              className={cn(
                "px-3 py-1 text-[11px] font-medium border-b-2 transition-colors",
                activeView === tab
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === "thread" && "Thread"}
              {tab === "case-info" && "Case Info"}
              {tab === "agency" && (
                <>
                  Agency
                  {pendingAgencyCandidatesCount > 0 && (
                    <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{pendingAgencyCandidatesCount}</Badge>
                  )}
                </>
              )}
              {tab === "timeline" && (
                <>
                  Timeline
                  {timeline_events.length > 0 && (
                    <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{timeline_events.length}</Badge>
                  )}
                </>
              )}
            </button>
          ))}
          {/* Intel tab — mobile only (sidebar is hidden on mobile) */}
          <button
            className={cn(
              "px-3 py-1 text-[11px] font-medium border-b-2 transition-colors md:hidden",
              activeView === "intel"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => {
              if (activeView === "intel") setActiveView("thread");
              else { setActiveView("intel"); setBottomDrawer(null); }
            }}
          >
            Intel
          </button>
          <span className="text-border mx-1 hidden sm:inline">|</span>
          {/* Drawer tabs */}
          {(["runs", "agent-log"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setBottomDrawer(bottomDrawer === tab ? null : tab)}
              className={cn(
                "px-3 py-1 text-[11px] font-medium border-b-2 transition-colors",
                bottomDrawer === tab
                  ? "border-dashed border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === "runs" && "Runs"}
              {tab === "agent-log" && "Agent Log"}
              {tab === "runs" && runsData?.runs && runsData.runs.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{runsData.runs.length}</Badge>
              )}
            </button>
          ))}
        </div>
        {/* Bottom drawer content */}
        {bottomDrawer && (
          <div className="max-h-[300px] overflow-auto border-t border-border/50">
            {bottomDrawer === "runs" && (
              <div className="p-3">
                {runsData?.runs && runsData.runs.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[10px] h-7">ID</TableHead>
                        <TableHead className="text-[10px] h-7">Trigger</TableHead>
                        <TableHead className="text-[10px] h-7">Status</TableHead>
                        <TableHead className="text-[10px] h-7">Started</TableHead>
                        <TableHead className="text-[10px] h-7">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runsData.runs.slice(0, 20).map((run) => (
                        <TableRow key={run.id}>
                          <TableCell className="text-[11px] py-1 font-mono">{String(run.id).slice(-6)}</TableCell>
                          <TableCell className="text-[11px] py-1">{run.trigger_type}</TableCell>
                          <TableCell className="text-[11px] py-1">
                            <Badge variant="outline" className="text-[10px] px-1 py-0">{run.status}</Badge>
                          </TableCell>
                          <TableCell className="text-[11px] py-1">{formatRelativeTime(run.started_at)}</TableCell>
                          <TableCell className="text-[11px] py-1">{run.final_action || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-xs text-muted-foreground">No runs yet</p>
                )}
              </div>
            )}
            {bottomDrawer === "agent-log" && (
              <div className="p-3">
                <AgentLogSection caseId={id!} compact />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── MODALS ─────────────────────────────────────────────────────────── */}
      <AdjustModal
        open={adjustModalOpen}
        onOpenChange={setAdjustModalOpen}
        onSubmit={handleRevise}
        isLoading={isRevising}
      />
      <AdjustModal
        open={pendingAdjustModalOpen}
        onOpenChange={setPendingAdjustModalOpen}
        onSubmit={handleAdjustPending}
        isLoading={isAdjustingPending}
      />
      <SnoozeModal
        open={snoozeModalOpen}
        onOpenChange={setSnoozeModalOpen}
        onSnooze={async (snoozeUntil) => { mutate(); }}
      />

      {/* Add Constraint dialog */}
      <Dialog open={addConstraintOpen} onOpenChange={setAddConstraintOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Constraint</DialogTitle>
            <DialogDescription>Add a new constraint or requirement to this case.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label htmlFor="constraint-type" className="text-sm font-medium">Type</label>
              <Select value={newConstraintType} onValueChange={setNewConstraintType}>
                <SelectTrigger id="constraint-type" name="constraint-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FEE_REQUIRED">Fee Required</SelectItem>
                  <SelectItem value="PREPAYMENT_REQUIRED">Prepayment Required</SelectItem>
                  <SelectItem value="ID_REQUIRED">ID Required</SelectItem>
                  <SelectItem value="CERTIFICATION_REQUIRED">Certification Required</SelectItem>
                  <SelectItem value="REDACTION_REQUIRED">Redaction Required</SelectItem>
                  <SelectItem value="EXEMPTION">Exemption</SelectItem>
                  <SelectItem value="NOT_HELD">Not Held</SelectItem>
                  <SelectItem value="PARTIAL_DENIAL">Partial Denial</SelectItem>
                  <SelectItem value="DENIAL_RECEIVED">Denial Received</SelectItem>
                  <SelectItem value="WRONG_AGENCY_REFERRAL">Wrong Agency Referral</SelectItem>
                  <SelectItem value="INVESTIGATION_ACTIVE">Investigation Active</SelectItem>
                  <SelectItem value="SCOPE_NARROWING_SUGGESTED">Scope Narrowing Suggested</SelectItem>
                  <SelectItem value="WITHDRAWAL_IF_NO_RESPONSE_10_BUSINESS_DAYS">Withdrawal if No Response</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="constraint-description" className="text-sm font-medium">Description</label>
              <Textarea
                id="constraint-description"
                name="constraint-description"
                value={newConstraintDesc}
                onChange={(e) => setNewConstraintDesc(e.target.value)}
                placeholder="Describe the constraint..."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddConstraintOpen(false)}>Cancel</Button>
            <Button onClick={handleAddConstraint} disabled={!newConstraintDesc.trim()}>Add Constraint</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showPasteInboundDialog && (
        <PasteInboundDialog
          caseId={parseInt(id)}
          open={showPasteInboundDialog}
          onOpenChange={setShowPasteInboundDialog}
          onSuccess={() => { mutate(); mutateRuns(); startPolling(); }}
        />
      )}
      {showCorrespondenceDialog && (
        <AddCorrespondenceDialog
          caseId={parseInt(id)}
          open={showCorrespondenceDialog}
          onOpenChange={setShowCorrespondenceDialog}
          onSuccess={() => { mutate(); }}
        />
      )}

      {/* Withdraw dialog */}
      <Dialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw Request</DialogTitle>
            <DialogDescription>
              This will close the request and mark it as withdrawn. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleWithdraw} disabled={isResolving}>
              {isResolving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Withdraw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark as Bugged dialog */}
      <Dialog open={bugDialogOpen} onOpenChange={setBugDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as Bugged</DialogTitle>
            <DialogDescription>
              This flags the case for investigation. Describe what looks wrong so we can fix it.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="What's wrong with this case? (e.g., email sent to wrong agency, stuck in loop, incorrect draft...)"
            value={bugDescription}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setBugDescription(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBugDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleMarkBugged} disabled={isResolving}>
              {isResolving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Bug className="h-4 w-4 mr-2" />}
              Mark as Bugged
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Guide AI dialog */}
      <Dialog open={guideModalOpen} onOpenChange={setGuideModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Guide AI</DialogTitle>
            <DialogDescription>Tell the AI what to do next for this case.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            const instruction = formData.get("instruction") as string;
            if (instruction?.trim()) handleGuideAI(instruction);
          }}>
            <Textarea name="instruction" placeholder="e.g., Send a follow-up requesting status update" rows={3} className="mb-3" />
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => setGuideModalOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isGuidingAI}>
                {isGuidingAI ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Bot className="h-4 w-4 mr-2" />}
                Submit
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Inbound message selection dialog */}
      <Dialog open={showInboundDialog} onOpenChange={setShowInboundDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select Inbound Message</DialogTitle>
            <DialogDescription>Choose which inbound message to process.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[300px] overflow-auto">
            {unprocessedInboundMessages.map((msg) => (
              <button
                key={msg.id}
                onClick={() => handleRunInbound(msg.id)}
                disabled={isRunningInbound}
                className={cn(
                  "w-full text-left p-2 rounded border hover:bg-accent/50 text-xs",
                  isRunningInbound && "opacity-50"
                )}
              >
                <div className="font-medium">{msg.subject || "No subject"}</div>
                <div className="text-muted-foreground mt-0.5">{msg.from_email} · {formatRelativeTime(msg.sent_at)}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Page wrapper ─────────────────────────────────────────────────────────────

export default function DetailV2Page() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <DetailV2Content />
    </Suspense>
  );
}
