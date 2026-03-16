"use client";

import { useState, useMemo, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import { useUserFilter } from "@/components/user-filter";
import { useAuth } from "@/components/auth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { cn, formatRelativeTime, formatDate, humanizeRiskFlag, condenseReviewNotes, formatReasoningItem, cleanEmailBody, humanizeSubstatus } from "@/lib/utils";
import type { ThreadMessage } from "@/lib/types";
import { Thread } from "@/components/thread";
import { LinkifiedText } from "@/components/linkified-text";
import { AddCorrespondenceDialog } from "@/components/add-correspondence-dialog";
import { AttachmentPicker, type Attachment } from "@/components/attachment-picker";
import {
  Loader2,
  CheckCircle,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  RefreshCw,
  Edit,
  Trash2,
  Ban,
  Send,
  ExternalLink,
  Radio,
  ChevronDown,
  Shield,
  FileText,
  AlertCircle,
  Activity,
  Phone,
  Mail,
  ArrowUpRight,
  MessageSquare,
  RotateCcw,
  Undo2,
  Clock,
  Paperclip,
  DollarSign,
  CalendarDays,
  ListChecks,
  CheckSquare,
  Square,
  Bug,
  Brain,
  Globe,
  Copy,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/* ─────────────────────────────────────────────
   Types — Monitor API shapes
   ───────────────────────────────────────────── */

interface LiveOverview {
  success: boolean;
  summary: {
    inbound_24h: number;
    pending_approvals_total: number;
    human_review_total: number;
    unmatched_inbound_total: number;
    active_runs_total: number;
    stuck_runs_total: number;
  };
  pending_approvals: PendingProposal[];
  human_review_cases: HumanReviewCase[];
  unmatched_inbound: UnmatchedMessage[];
}

interface PendingProposal {
  id: number;
  case_id: number;
  case_name: string;
  agency_name: string;
  action_type: string;
  reasoning: unknown;
  confidence: number | null;
  risk_flags: string[] | null;
  warnings: string[] | null;
  draft_subject: string | null;
  draft_body_text?: string | null;
  draft_body?: string | null;
  created_at: string;
  proposal_pause_reason: string | null;
  case_pause_reason: string | null;
  case_status?: string | null;
  case_substatus?: string | null;
  last_inbound_preview: string | null;
  last_inbound_subject: string | null;
  inbound_count: number;
  trigger_message_id: number | null;
  trigger_message?: {
    from_email: string | null;
    subject: string | null;
    body_preview: string | null;
  } | null;
  portal_url?: string | null;
  agency_email?: string | null;
  effective_agency_email?: string | null;
  user_id?: number | null;
  attachments?: Array<{
    id: number;
    message_id: number;
    filename: string | null;
    content_type: string | null;
    size_bytes: number | null;
    download_url: string;
    direction?: 'inbound' | 'outbound';
  }>;
  attachment_insights?: {
    total: number;
    has_pdf: boolean;
    has_extracted_text: boolean;
    fee_amounts: number[];
    deadline_mentions: string[];
    highlights: string[];
    filename_signals: string[];
  };
  gate_options?: string[] | null;
  deadline_date?: string | null;
}

interface HumanReviewCase {
  id: number;
  case_name: string;
  agency_name: string;
  status: string;
  substatus: string | null;
  pause_reason: string | null;
  updated_at: string;
  last_inbound_preview: string | null;
  inbound_count: number;
  last_fee_quote_amount: number | null;
  portal_url: string | null;
  last_portal_status: string | null;
  last_portal_task_url: string | null;
  research_summary?: string | null;
  phone_call_plan?: {
    agency_name?: string | null;
    agency_phone?: string | null;
    agency_email?: string | null;
    portal_url?: string | null;
    reason?: string | null;
    outcome?: string | null;
    suggested_agency?: string | null;
  } | null;
  user_id?: number | null;
}

interface UnmatchedMessage {
  id: number;
  from_email: string;
  subject: string;
  body_preview: string | null;
  received_at: string;
  created_at: string;
}

interface ProposalDetailResponse {
  success: boolean;
  proposal: {
    id: number;
    case_id: number;
    action_type: string;
    draft_subject: string | null;
    draft_body_text: string | null;
    reasoning: string[] | null;
    confidence: number | null;
    risk_flags: string[] | null;
    warnings: string[] | null;
    pause_reason: string | null;
    status: string;
    case?: {
      name: string;
      subject_name: string;
      agency_name: string;
      state: string;
      status: string;
      autopilot_mode: string;
    } | null;
    analysis?: {
      classification: string | null;
      sentiment: string | null;
      extracted_fee_amount: number | null;
    } | null;
  };
}

type QueueItem =
  | { type: "proposal"; data: PendingProposal }
  | { type: "review"; data: HumanReviewCase };

type TabId = "queue" | "inbound" | "calls";

interface SuggestedCase {
  id: number;
  case_name: string;
  agency_name: string;
}

interface InboundMessage {
  id: number;
  from_email: string;
  subject: string;
  body_text: string | null;
  received_at: string;
  case_id: number | null;
  case_name: string | null;
  agency_name: string | null;
  intent: string | null;
  sentiment: string | null;
  suggested_action: string | null;
  key_points: string[] | null;
  suggested_cases: SuggestedCase[] | null;
}

interface InboundResponse {
  success: boolean;
  count: number;
  inbound: InboundMessage[];
}

interface PhoneCallTask {
  id: number;
  case_id: number;
  status: string;
  reason: string | null;
  agency_phone: string | null;
  ai_briefing: unknown;
  assigned_to: string | null;
  case_name?: string | null;
  agency_name?: string | null;
  agency_email?: string | null;
  agency_state?: string | null;
  subject_name?: string | null;
  days_since_sent?: number | null;
  notes?: string | null;
  phone_options?: {
    candidates?: Array<{
      phone: string;
      kind?: "phone" | "fax";
      source?: string;
      agency_name?: string | null;
      contact_name?: string | null;
      is_new?: boolean;
    }>;
    notion?: { phone: string; source: string; pd_page_url?: string };
    web_search?: { phone: string; source: string; confidence?: string; reasoning?: string };
  } | null;
  call_outcome?: string | null;
  created_at?: string;
  case_status?: string | null;
  case_substatus?: string | null;
  case_pause_reason?: string | null;
  requested_records?: string[] | string | null;
  additional_details?: string | null;
  last_inbound_subject?: string | null;
  last_inbound_from_email?: string | null;
  last_inbound_preview?: string | null;
}

interface PhoneCallsResponse {
  success: boolean;
  count: number;
  stats: {
    pending: number;
    claimed: number;
    completed: number;
    skipped: number;
  };
  tasks: PhoneCallTask[];
}

/* ─────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────── */

const DISMISS_REASONS = [
  "Wrong action",
  "Already handled",
  "Duplicate",
  "Bad timing",
  "Not needed",
];

const PAUSE_LABELS: Record<string, string> = {
  FEE_QUOTE: "FEE",
  DENIAL: "DENIAL",
  SCOPE: "SCOPE",
  ID_REQUIRED: "ID REQ",
  SENSITIVE: "SENSITIVE",
  CLOSE_ACTION: "CLOSE",
  PORTAL: "PORTAL",
  HOSTILE_SENTIMENT: "HOSTILE",
  TIMED_OUT: "TIMEOUT",
  PENDING_APPROVAL: "PENDING",
  INITIAL_REQUEST: "INITIAL",
};

/* ─────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────── */

function formatReasoning(reasoning: unknown): string[] {
  if (!reasoning) return [];
  if (Array.isArray(reasoning)) {
    return reasoning.map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") {
        const obj = r as Record<string, unknown>;
        return String(obj.detail || obj.step || obj.text || obj.summary || JSON.stringify(r));
      }
      return String(r);
    }).filter(Boolean);
  }
  if (typeof reasoning === "string") return [reasoning];
  if (typeof reasoning === "object" && reasoning !== null) {
    const obj = reasoning as Record<string, unknown>;
    if (obj.summary) return [String(obj.summary)];
    if (obj.text) return [String(obj.text)];
  }
  return [];
}

function extractEscalationRequestedAction(reasoning: string[]): string | null {
  for (const rawLine of reasoning) {
    const line = typeof rawLine === "string" ? rawLine : String(rawLine ?? "");
    if (!line) continue;
    const match = line.match(/action\s*[:=]\s*([a-z_]+)/i);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

function extractManualPdfEscalation(reasoning: string[]) {
  const normalized = reasoning
    .map((line) => formatReasoningItem(line))
    .filter(Boolean);
  const instruction =
    normalized.find((line) => /human should complete .*\.pdf manually and send/i.test(line)) || null;
  if (!instruction) return null;
  const attachmentMatch = instruction.match(/complete\s+(.+?\.pdf)\s+manually/i);
  const failureLine =
    normalized.find((line) => /automatic pdf form preparation failed:/i.test(line)) || null;
  return {
    instruction,
    attachmentName: attachmentMatch?.[1] || null,
    failureReason: failureLine
      ? failureLine.replace(/^automatic pdf form preparation failed:\s*/i, "")
      : null,
  };
}

const ACTION_LABELS: Record<string, string> = {
  SEND_REBUTTAL: "SEND REBUTTAL",
  SEND_APPEAL: "SEND APPEAL",
  SEND_FOLLOWUP: "SEND FOLLOW-UP",
  SEND_INITIAL_REQUEST: "SEND REQUEST",
  SEND_CLARIFICATION: "SEND CLARIFICATION",
  SEND_FEE_WAIVER_REQUEST: "SEND FEE WAIVER",
  SEND_STATUS_UPDATE: "SEND STATUS UPDATE",
  NEGOTIATE_FEE: "SEND FEE NEGOTIATION",
  ACCEPT_FEE: "ACCEPT FEE",
  DECLINE_FEE: "DECLINE FEE",
  RESPOND_PARTIAL_APPROVAL: "RESPOND TO PARTIAL",
  SUBMIT_PORTAL: "SUBMIT VIA PORTAL",
  SEND_PDF_EMAIL: "SEND PDF REQUEST",
  RESEARCH_AGENCY: "RUN RESEARCH",
  REFORMULATE_REQUEST: "REFORMULATE REQUEST",
  CLOSE_CASE: "CLOSE CASE",
  ESCALATE: "REPROCESS WITH GUIDANCE",
};

/** Detect raw Notion/Trello/Airtable import dumps that shouldn't display to operators */
function isRawImportDump(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  return (
    t.startsWith("--- Notion Fields ---") ||
    t.startsWith("Attachments") ||
    t.startsWith("Trello Card Description") ||
    t.startsWith("Original Trello Card:") ||
    t.startsWith("Airtable Notes") ||
    /^#{1,3}\s*(Incident|FOIA Requests|Police Departments Involved)/m.test(t) ||
    (t.includes("trello.com/c/") && t.includes("###")) ||
    (t.length > 2000 && t.includes("###") && t.includes("FOIA"))
  );
}

function getApproveLabel(actionType: string | null): string {
  const normalized = typeof actionType === "string" ? actionType : String(actionType ?? "");
  if (!normalized) return "APPROVE & EXECUTE";
  return ACTION_LABELS[normalized] || `APPROVE: ${normalized.replace(/_/g, " ")}`;
}

function getFeeDecisionLabel(action: "ADD_TO_INVOICING" | "WAIT_FOR_GOOD_TO_PAY"): string {
  return action === "ADD_TO_INVOICING" ? "Add to Invoicing" : "Wait for Good to Pay";
}

function getActionExplanation(actionType: string | null, hasDraft: boolean, portalUrl?: string | null, agencyEmail?: string | null): string {
  const normalized = typeof actionType === "string" ? actionType : String(actionType ?? "");
  if (!normalized) return "Approve this proposal to execute it.";
  const explanations: Record<string, string> = {
    SEND_REBUTTAL: "Will send a rebuttal challenging the agency's denial, citing relevant statutes.",
    SEND_APPEAL: "Will file a formal appeal of the agency's denial.",
    SEND_FOLLOWUP: "Will send a follow-up email asking for a status update.",
    SEND_INITIAL_REQUEST: "Will send the initial FOIA/public records request via email.",
    SEND_CLARIFICATION: "Will respond to the agency's question or request for clarification.",
    SEND_FEE_WAIVER_REQUEST: "Will request a fee waiver from the agency.",
    NEGOTIATE_FEE: "Will send a fee negotiation response to the agency.",
    ACCEPT_FEE: "Will accept the quoted fee and authorize payment.",
    DECLINE_FEE: "Will decline the quoted fee.",
    RESPOND_PARTIAL_APPROVAL: "Will respond to the agency's partial approval/release.",
    SUBMIT_PORTAL: "Will submit the request through the agency's online portal.",
    SEND_PDF_EMAIL: "Will email a PDF copy of the request to the agency.",
    RESEARCH_AGENCY: "Will research the agency's contact information and procedures.",
    REFORMULATE_REQUEST: "Will rewrite and resubmit a narrower/clearer request.",
    CLOSE_CASE: "Will close this case.",
    ESCALATE: "The system couldn't determine next steps. Review the reasoning and choose an action.",
  };
  let explanation = explanations[normalized] || `Will execute: ${normalized.replace(/_/g, " ").toLowerCase()}.`;
  if (!hasDraft && normalized.startsWith("SEND")) {
    explanation += " The AI will generate the draft before sending.";
  }
  // Add delivery target for clarity
  if (normalized === "SUBMIT_PORTAL" && portalUrl) {
    explanation += ` Target: ${portalUrl}`;
  } else if (normalized.startsWith("SEND") && agencyEmail) {
    explanation += ` To: ${agencyEmail}`;
  }
  return explanation;
}

function getPauseReason(item: QueueItem): string | null {
  if (item.type === "proposal") {
    return item.data.proposal_pause_reason || item.data.case_pause_reason || null;
  }
  return item.data.status || null;
}

function deriveDisplayAgencyName(review: {
  agency_name?: string | null;
  research_summary?: string | null;
}): string {
  const current = (review.agency_name || "").trim();
  if (current && !/^police department$/i.test(current)) return current;
  const summary = review.research_summary || "";
  const match = summary.match(/^Suggested agency:\s*(.+)$/mi);
  if (match?.[1]) return match[1].trim();
  return current || "Unknown agency";
}

function hasCallablePhone(value: string | null | undefined): boolean {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7;
}

type ReviewCategory = "fee" | "portal" | "denial" | "phone" | "general";

function categorizeReview(review: HumanReviewCase): ReviewCategory {
  const pr = (review.pause_reason || "").toUpperCase();
  const sub = (review.substatus || "").toUpperCase();
  const status = (review.status || "").toUpperCase();
  const portalStatus = (review.last_portal_status || "").toUpperCase();
  const phoneOutcome = (review.phone_call_plan?.outcome || "").toUpperCase();
  const hasPhoneTarget = hasCallablePhone(review.phone_call_plan?.agency_phone);

  // Research handoff / phone-call cases are not portal retries, even if
  // a historical portal URL exists on the case record.
  const explicitPhoneRouting =
    status.includes("PHONE_CALL") ||
    phoneOutcome.includes("PHONE_FALLBACK") ||
    pr.includes("FOLLOWUP_CHANNEL:PHONE");
  if ((explicitPhoneRouting && hasPhoneTarget) || (status.includes("PHONE_CALL") && hasPhoneTarget)) {
    return "phone";
  }
  if (pr.includes("RESEARCH") || sub.includes("RESEARCH")) {
    return "general";
  }
  if (
    sub.includes("NO ONLINE PORTAL") ||
    sub.includes("NO PORTAL URL AVAILABLE") ||
    portalStatus.includes("NOT_REAL_PORTAL") ||
    portalStatus.includes("PDF_FORM_PENDING") ||
    portalStatus.includes("CONTACT_INFO_ONLY") ||
    portalStatus.includes("ALTERNATIVE PATH REQUIRED")
  ) {
    return "general";
  }

  if (pr.includes("FEE") || sub.includes("FEE") || status.includes("FEE") || review.last_fee_quote_amount != null) return "fee";
  if (pr.includes("PORTAL") || sub.includes("PORTAL") || status.includes("PORTAL")) return "portal";
  if (pr.includes("DENIAL") || sub.includes("DENIAL") || sub.includes("DENIED")) return "denial";
  return "general";
}

/* ─────────────────────────────────────────────
   SSE Hook
   ───────────────────────────────────────────── */

function useSSE(url: string, onEvent: () => void) {
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      // Clear any pending reconnect
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Close any existing connection
      if (source) {
        source.close();
        source = null;
      }

      const es = new EventSource(url);
      source = es;

      es.onopen = () => {
        if (!disposed) setConnected(true);
      };

      es.onerror = () => {
        if (disposed) return;
        setConnected(false);
        es.close();
        if (source === es) source = null;
        reconnectTimer = setTimeout(connect, 5000);
      };

      const refreshEvents = [
        "proposal_update",
        "case_update",
        "message_new",
        "run_status",
      ];
      refreshEvents.forEach((evt) => {
        es.addEventListener(evt, () => {
          if (!disposed) callbackRef.current();
        });
      });
    }

    connect();

    return () => {
      disposed = true;
      if (source) source.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [url]);

  return connected;
}

/* ─────────────────────────────────────────────
   Stat Box
   ───────────────────────────────────────────── */

function StatBox({
  label,
  value,
  icon: Icon,
  color,
  onClick,
  active,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "border bg-card p-3",
        onClick && "cursor-pointer hover:bg-muted/50 transition-colors",
        active && "ring-1 ring-foreground"
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn("h-3.5 w-3.5", color || "text-muted-foreground")} />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <span className={cn("text-2xl font-bold tabular-nums", color || "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Section Label
   ───────────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
      {children}
    </p>
  );
}

/* ─────────────────────────────────────────────
   Health Metric Detail — drill-down panel
   ───────────────────────────────────────────── */

type HealthMetricKey =
  | "stuck_cases"
  | "orphaned_runs"
  | "stale_proposals"
  | "overdue_deadlines"
  | "bounced_emails"
  | "portal_failures"
  | "inbound_linkage_gaps"
  | "empty_normalized_inbound"
  | "proposal_message_mismatches";

function HealthMetricDetail({ metric, onClose }: { metric: HealthMetricKey; onClose: () => void }) {
  const { data, isLoading, error } = useSWR<{
    success: boolean;
    metric: string;
    count: number;
    items: Record<string, unknown>[];
  }>(`/api/monitor/system-health/details?metric=${metric}`);

  if (isLoading) {
    return (
      <div className="border border-t-0 bg-card px-3 py-4 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading details...
      </div>
    );
  }

  if (error || !data?.success) {
    return (
      <div className="border border-t-0 bg-card px-3 py-2 text-xs text-red-400">
        Failed to load details.{" "}
        <button onClick={onClose} className="underline text-muted-foreground ml-1">Close</button>
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="border border-t-0 bg-card px-3 py-2 text-xs text-muted-foreground">
        No records found.{" "}
        <button onClick={onClose} className="underline ml-1">Close</button>
      </div>
    );
  }

  // Render based on metric type
  const renderStuckCases = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Case</th>
          <th className="pb-1 font-medium">Agency</th>
          <th className="pb-1 font-medium">Status</th>
          <th className="pb-1 font-medium">Pause Reason</th>
          <th className="pb-1 font-medium">Updated</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5">
              <Link href={`/requests/detail-v2?id=${item.id}`} className="text-blue-400 hover:underline">
                #{item.id}
              </Link>
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.agency_name}</td>
            <td className="py-1.5"><Badge variant="outline" className="text-[10px] h-4">{item.status}</Badge></td>
            <td className="py-1.5 text-muted-foreground">{item.pause_reason || "-"}</td>
            <td className="py-1.5 text-muted-foreground">{formatRelativeTime(item.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderStaleProposals = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Case</th>
          <th className="pb-1 font-medium">Agency</th>
          <th className="pb-1 font-medium">Action</th>
          <th className="pb-1 font-medium">Proposal Status</th>
          <th className="pb-1 font-medium">Created</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.proposal_id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5">
              <Link href={`/requests/detail-v2?id=${item.case_id}`} className="text-blue-400 hover:underline">
                #{item.case_id}
              </Link>
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.agency_name}</td>
            <td className="py-1.5"><Badge variant="outline" className="text-[10px] h-4">{item.action_type}</Badge></td>
            <td className="py-1.5"><Badge variant="outline" className="text-[10px] h-4">{item.proposal_status}</Badge></td>
            <td className="py-1.5 text-muted-foreground">{formatRelativeTime(item.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderOverdueDeadlines = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Case</th>
          <th className="pb-1 font-medium">Agency</th>
          <th className="pb-1 font-medium">Status</th>
          <th className="pb-1 font-medium">Deadline</th>
          <th className="pb-1 font-medium">Days Overdue</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5">
              <Link href={`/requests/detail-v2?id=${item.id}`} className="text-blue-400 hover:underline">
                #{item.id}
              </Link>
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.agency_name}</td>
            <td className="py-1.5"><Badge variant="outline" className="text-[10px] h-4">{item.status}</Badge></td>
            <td className="py-1.5 text-muted-foreground">{item.deadline_date ? new Date(item.deadline_date).toLocaleDateString() : "-"}</td>
            <td className="py-1.5 text-red-400 font-medium">{item.days_overdue}d</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderPortalFailures = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Case</th>
          <th className="pb-1 font-medium">Agency</th>
          <th className="pb-1 font-medium">Action</th>
          <th className="pb-1 font-medium">Portal</th>
          <th className="pb-1 font-medium">Updated</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.task_id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5">
              <Link href={`/requests/detail-v2?id=${item.case_id}`} className="text-blue-400 hover:underline">
                #{item.case_id}
              </Link>
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.agency_name}</td>
            <td className="py-1.5"><Badge variant="outline" className="text-[10px] h-4">{item.action_type}</Badge></td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[120px]">{item.portal_url || "-"}</td>
            <td className="py-1.5 text-muted-foreground">{formatRelativeTime(item.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderOrphanedRuns = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Run</th>
          <th className="pb-1 font-medium">Case</th>
          <th className="pb-1 font-medium">Agency</th>
          <th className="pb-1 font-medium">Type</th>
          <th className="pb-1 font-medium">Started</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.run_id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5 text-muted-foreground">#{item.run_id}</td>
            <td className="py-1.5">
              {item.case_id ? (
                <Link href={`/requests/detail-v2?id=${item.case_id}`} className="text-blue-400 hover:underline">
                  #{item.case_id}
                </Link>
              ) : "-"}
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.agency_name || "-"}</td>
            <td className="py-1.5"><Badge variant="outline" className="text-[10px] h-4">{item.trigger_type}</Badge></td>
            <td className="py-1.5 text-muted-foreground">{formatRelativeTime(item.started_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderBouncedEmails = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Case</th>
          <th className="pb-1 font-medium">Agency</th>
          <th className="pb-1 font-medium">From</th>
          <th className="pb-1 font-medium">To</th>
          <th className="pb-1 font-medium">Bounced</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.message_id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5">
              {item.case_id ? (
                <Link href={`/requests/detail-v2?id=${item.case_id}`} className="text-blue-400 hover:underline">
                  #{item.case_id}
                </Link>
              ) : "-"}
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.agency_name || "-"}</td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[140px]">{item.from_email}</td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[140px]">{item.to_email}</td>
            <td className="py-1.5 text-muted-foreground">{formatRelativeTime(item.bounced_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderInboundLinkageGaps = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Message</th>
          <th className="pb-1 font-medium">From</th>
          <th className="pb-1 font-medium">Subject</th>
          <th className="pb-1 font-medium">Thread</th>
          <th className="pb-1 font-medium">Received</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.message_id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5 text-muted-foreground">#{item.message_id}</td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.from_email || "-"}</td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[280px]">{item.subject || "(no subject)"}</td>
            <td className="py-1.5 text-muted-foreground">{item.thread_id ? `#${item.thread_id}` : "-"}</td>
            <td className="py-1.5 text-muted-foreground">{formatRelativeTime(item.received_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderEmptyNormalizedInbound = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Message</th>
          <th className="pb-1 font-medium">Case</th>
          <th className="pb-1 font-medium">From</th>
          <th className="pb-1 font-medium">Source</th>
          <th className="pb-1 font-medium">Attachments</th>
          <th className="pb-1 font-medium">Received</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.message_id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5 text-muted-foreground">#{item.message_id}</td>
            <td className="py-1.5">
              {item.case_id ? (
                <Link href={`/requests/detail-v2?id=${item.case_id}`} className="text-blue-400 hover:underline">
                  #{item.case_id}
                </Link>
              ) : "-"}
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[160px]">{item.from_email || "-"}</td>
            <td className="py-1.5 text-muted-foreground">{item.normalized_body_source || "-"}</td>
            <td className="py-1.5 text-muted-foreground">{item.attachment_count ?? 0}</td>
            <td className="py-1.5 text-muted-foreground">{formatRelativeTime(item.received_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderProposalMessageMismatches = () => (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="pb-1 font-medium">Proposal</th>
          <th className="pb-1 font-medium">Proposal Case</th>
          <th className="pb-1 font-medium">Message Case</th>
          <th className="pb-1 font-medium">Proposal Agency</th>
          <th className="pb-1 font-medium">Message Agency</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((item: any) => (
          <tr key={item.proposal_id} className="border-t border-border/50 hover:bg-muted/30">
            <td className="py-1.5 text-muted-foreground">#{item.proposal_id}</td>
            <td className="py-1.5">
              <Link href={`/requests/detail-v2?id=${item.proposal_case_id}`} className="text-blue-400 hover:underline">
                #{item.proposal_case_id}
              </Link>
            </td>
            <td className="py-1.5">
              <Link href={`/requests/detail-v2?id=${item.message_case_id}`} className="text-blue-400 hover:underline">
                #{item.message_case_id}
              </Link>
            </td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[180px]">{item.proposal_agency_name || "-"}</td>
            <td className="py-1.5 text-muted-foreground truncate max-w-[180px]">{item.message_agency_name || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderers: Record<HealthMetricKey, () => React.ReactNode> = {
    stuck_cases: renderStuckCases,
    stale_proposals: renderStaleProposals,
    overdue_deadlines: renderOverdueDeadlines,
    portal_failures: renderPortalFailures,
    orphaned_runs: renderOrphanedRuns,
    bounced_emails: renderBouncedEmails,
    inbound_linkage_gaps: renderInboundLinkageGaps,
    empty_normalized_inbound: renderEmptyNormalizedInbound,
    proposal_message_mismatches: renderProposalMessageMismatches,
  };

  return (
    <div className="col-span-full border border-t-0 bg-card px-3 py-3 overflow-x-auto">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {data.count} record{data.count !== 1 ? "s" : ""}
        </span>
        <button onClick={onClose} className="text-[10px] text-muted-foreground hover:text-foreground">
          Close
        </button>
      </div>
      {renderers[metric]()}
    </div>
  );
}

/* ─────────────────────────────────────────────
   Main Component
   ───────────────────────────────────────────── */

function MonitorPageContent() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [adjustInstruction, setAdjustInstruction] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [showCorrespondence, setShowCorrespondence] = useState(false);
  const [showAddCorrespondenceDialog, setShowAddCorrespondenceDialog] = useState(false);
  const [addCorrespondenceCaseId, setAddCorrespondenceCaseId] = useState<number | null>(null);
  const [correspondenceMessages, setCorrespondenceMessages] = useState<ThreadMessage[]>([]);
  const [correspondenceLoading, setCorrespondenceLoading] = useState(false);
  const [portalHelper, setPortalHelper] = useState<any>(null);
  const [portalHelperCaseId, setPortalHelperCaseId] = useState<number | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [inboundFilter, setInboundFilter] = useState<"all" | "unmatched" | "matched">("all");
  const [expandedMessageId, setExpandedMessageId] = useState<number | null>(null);
  const [matchingMessageId, setMatchingMessageId] = useState<number | null>(null);
  const [manualCaseId, setManualCaseId] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("queue");
  const [reviewInstruction, setReviewInstruction] = useState("");
  const [expandedPhoneCallId, setExpandedPhoneCallId] = useState<number | null>(null);
  const [phoneCallSubmitting, setPhoneCallSubmitting] = useState<number | null>(null);
  const [addingToPhoneQueue, setAddingToPhoneQueue] = useState(false);
  const [checkedPoints, setCheckedPoints] = useState<Set<number>>(new Set());
  const [callNotes, setCallNotes] = useState("");
  const [callOutcome, setCallOutcome] = useState<string | null>(null);
  const [nextStepSuggestion, setNextStepSuggestion] = useState<{ next_action: string; explanation: string; draft_notes?: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [editedBody, setEditedBody] = useState<string>("");
  const [editedSubject, setEditedSubject] = useState<string>("");
  const [editedRecipient, setEditedRecipient] = useState<string>("");
  const [outboundAttachments, setOutboundAttachments] = useState<Attachment[]>([]);
  const [queueFilter, setQueueFilter] = useState<"all" | "proposals" | "reviews">("all");
  const [expandedHealthMetric, setExpandedHealthMetric] = useState<HealthMetricKey | null>(null);
  const [caseNotFoundId, setCaseNotFoundId] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    label: string;
    item: QueueItem;
    execute: () => Promise<void>;
    timerId: ReturnType<typeof setTimeout>;
    startedAt: number;
  } | null>(null);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [reviewNotesExpanded, setReviewNotesExpanded] = useState(false);
  const [riskFlagsExpanded, setRiskFlagsExpanded] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [showBulkConfirm, setShowBulkConfirm] = useState<{
    action: "APPROVE" | "DISMISS";
    reason?: string;
  } | null>(null);
  const [showDestructiveConfirm, setShowDestructiveConfirm] = useState<{
    title: string;
    description: string;
    onConfirm: () => void;
  } | null>(null);
  const [showDismissDialog, setShowDismissDialog] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showQueueList, setShowQueueList] = useState(false);
  const initialCaseApplied = useRef(false);
  const reviewInstructionRef = useRef<HTMLTextAreaElement | null>(null);
  const adjustInstructionRef = useRef<HTMLTextAreaElement | null>(null);

  const getReviewInstructionText = () =>
    (reviewInstructionRef.current?.value ?? reviewInstruction ?? "");
  const getAdjustInstructionText = () =>
    (adjustInstructionRef.current?.value ?? adjustInstruction ?? "");

  // ── Deep linking & user filter ─────────────
  const searchParams = useSearchParams();
  const { appendUser } = useUserFilter();
  const { user: authUser } = useAuth();
  const isAdmin = Boolean(authUser?.is_admin);

  // Fetch users for resolving user_id → name
  const { data: usersData } = useSWR<{ success: boolean; users: { id: number; name: string }[] }>("/api/users");
  const userNameMap = useMemo(() => {
    const map: Record<number, string> = {};
    for (const u of usersData?.users || []) map[u.id] = u.name;
    return map;
  }, [usersData]);

  // ── Data fetching ──────────────────────────

  const {
    data: overview,
    error,
    isLoading,
    mutate,
  } = useSWR<LiveOverview>(appendUser("/api/monitor/live-overview?limit=25"), {
    refreshInterval: 12000,
  });

  // System health
  const { data: healthData } = useSWR<{
    success: boolean;
    status: string;
    total_issues: number;
    metrics: {
      stuck_cases: number;
      stuck_breakdown?: {
        needs_human_review: number;
        needs_phone_call: number;
        needs_contact_info: number;
        needs_human_fee_approval: number;
        research_handoff: number;
      };
      orphaned_runs: number;
      stale_proposals: number;
      overdue_deadlines: number;
      bounced_emails: number;
      portal_failures: number;
      inbound_linkage_gaps: number;
      empty_normalized_inbound: number;
      proposal_message_mismatches: number;
    };
  }>(isAdmin ? "/api/monitor/system-health" : null, { refreshInterval: 60000 });

  // Build the full queue (unfiltered by type) — filter out acted-on items via removedIds
  const allQueueItems = useMemo<QueueItem[]>(() => {
    if (!overview) return [];
    const proposals: QueueItem[] = (overview.pending_approvals || []).map((p) => ({
      type: "proposal" as const,
      data: p,
    }));
    const reviews: QueueItem[] = (overview.human_review_cases || []).map((r) => ({
      type: "review" as const,
      data: r,
    }));
    return [...proposals, ...reviews].filter((item) => {
      const key = item.type === "proposal" ? `p:${item.data.id}` : `r:${item.data.id}`;
      return !removedIds.has(key);
    });
  }, [overview, removedIds]);

  // Local counts — instantly responsive to removals
  const localTotalAttention = allQueueItems.length;
  const localProposalCount = allQueueItems.filter(i => i.type === "proposal").length;
  const localReviewCount = allQueueItems.filter(i => i.type === "review").length;

  // Apply stat card type filter for display queue
  const queue = useMemo<QueueItem[]>(() => {
    if (queueFilter === "proposals") return allQueueItems.filter(i => i.type === "proposal");
    if (queueFilter === "reviews") return allQueueItems.filter(i => i.type === "review");
    return allQueueItems;
  }, [allQueueItems, queueFilter]);

  // Clamp index when queue shrinks
  const safeIndex = queue.length === 0 ? 0 : Math.min(currentIndex, queue.length - 1);
  useEffect(() => {
    if (safeIndex !== currentIndex) setCurrentIndex(safeIndex);
  }, [safeIndex, currentIndex]);
  const selectedItem = queue[safeIndex] || null;
  const isEscalateProposal =
    selectedItem?.type === "proposal" && selectedItem.data.action_type === "ESCALATE";
  const caseOwnerId = selectedItem?.data?.user_id ?? null;
  const isOwnCase = !caseOwnerId || caseOwnerId === authUser?.id || isAdmin;
  const canTakeAction = isOwnCase;

  // Reset per-item UI state when switching items
  useEffect(() => {
    setShowCorrespondence(false);
    setReasoningExpanded(false);
    setReviewNotesExpanded(false);
    setRiskFlagsExpanded(false);
  }, [safeIndex]);

  // Fetch portal_helper from workspace API for SUBMIT_PORTAL proposals
  useEffect(() => {
    if (selectedItem?.type !== "proposal") { setPortalHelper(null); return; }
    if (selectedItem.data.action_type !== "SUBMIT_PORTAL") { setPortalHelper(null); return; }
    const caseId = selectedItem.data.case_id;
    if (caseId === portalHelperCaseId && portalHelper) return; // already fetched
    setPortalHelper(null);
    setPortalHelperCaseId(caseId);
    (async () => {
      try {
        const res = await fetch(`/api/requests/${caseId}/workspace`);
        const data = await res.json();
        if (data.success && data.portal_helper) {
          setPortalHelper(data.portal_helper);
        }
      } catch {}
    })();
  }, [selectedItem]);

  // Deep link: on first load, jump to the case from ?case=XXXX
  useEffect(() => {
    if (initialCaseApplied.current || queue.length === 0) return;
    const caseParam = searchParams.get("case");
    if (!caseParam) { initialCaseApplied.current = true; return; }
    const targetId = parseInt(caseParam, 10);
    if (isNaN(targetId)) { initialCaseApplied.current = true; return; }
    const idx = queue.findIndex((item) => {
      const id = item.type === "proposal" ? item.data.case_id : item.data.id;
      return id === targetId;
    });
    if (idx >= 0) {
      setCurrentIndex(idx);
      setCaseNotFoundId(null);
    } else {
      setCaseNotFoundId(targetId);
    }
    initialCaseApplied.current = true;
  }, [queue, searchParams]);

  // Deep link: update URL when selected case changes
  useEffect(() => {
    if (!selectedItem) return;
    const caseId = selectedItem.type === "proposal"
      ? selectedItem.data.case_id
      : selectedItem.data.id;
    const url = new URL(window.location.href);
    url.searchParams.set("case", String(caseId));
    window.history.replaceState({}, "", url.toString());
  }, [selectedItem]);

  // Fetch full proposal detail for the selected proposal
  const selectedProposalId =
    selectedItem?.type === "proposal" ? selectedItem.data.id : null;
  const { data: proposalDetail } = useSWR<ProposalDetailResponse>(
    selectedProposalId ? `/api/proposals/${selectedProposalId}` : null
  );

  // Fetch audit trail for the selected case
  const selectedCaseId = selectedItem
    ? selectedItem.type === "proposal" ? selectedItem.data.case_id : selectedItem.data.id
    : null;
  const { data: auditData } = useSWR<{ success: boolean; actions: { id: number; event_type: string; description: string; created_at: string; user_id: number | null }[] }>(
    selectedCaseId ? `/api/monitor/cases/${selectedCaseId}/audit?limit=5` : null
  );

  // ── Inbound / Phone data (lazy: fetch phone queue on queue/calls tabs) ──

  const { data: inboundData, mutate: mutateInbound } = useSWR<InboundResponse>(
    activeTab === "inbound" ? appendUser("/api/monitor/inbound?limit=100") : null,
    { refreshInterval: 30000 }
  );

  const { data: phoneData, mutate: mutatePhone } = useSWR<PhoneCallsResponse>(
    (activeTab === "calls" || activeTab === "queue")
      ? appendUser("/api/phone-calls?limit=200")
      : null,
    { refreshInterval: 30000 }
  );

  const activePhoneQueueCaseIds = useMemo(() => {
    const ids = new Set<number>();
    for (const task of phoneData?.tasks || []) {
      if ((task.status === "pending" || task.status === "claimed") && Number.isFinite(task.case_id)) {
        ids.add(task.case_id);
      }
    }
    return ids;
  }, [phoneData?.tasks]);

  const selectedCaseAlreadyInPhoneQueue =
    selectedCaseId != null && activePhoneQueueCaseIds.has(selectedCaseId);

  // ── SSE ────────────────────────────────────

  const prevQueueLenRef = useRef(0);
  const sseUrl = appendUser("/api/monitor/events");
  const sseConnected = useSSE(sseUrl, () => {
    mutate();
    if (activeTab === "inbound") mutateInbound();
    if (activeTab === "calls") mutatePhone();
    // Browser notification when tab is not focused
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("AUTOBOT", { body: "New items need your attention" });
    }
  });

  // Request notification permission on first click
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "default") return;
    const handler = () => {
      Notification.requestPermission();
      document.removeEventListener("click", handler);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // Show toast when new items arrive while viewing the page
  useEffect(() => {
    if (prevQueueLenRef.current > 0 && queue.length > prevQueueLenRef.current) {
      const diff = queue.length - prevQueueLenRef.current;
      showToast(`${diff} new item${diff > 1 ? "s" : ""} added to queue`);
    }
    prevQueueLenRef.current = queue.length;
  }, [queue.length]);

  // ── Navigation ─────────────────────────────

  const navigate = useCallback(
    (delta: number) => {
      if (queue.length === 0) return;
      setCurrentIndex((prev) => {
        const next = prev + delta;
        if (next < 0) return queue.length - 1;
        if (next >= queue.length) return 0;
        return next;
      });
    },
    [queue.length]
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // Escape always works — close modals/dialogs
      if (e.key === "Escape") {
        if (showShortcutsHelp) { setShowShortcutsHelp(false); e.preventDefault(); return; }
        if (showDismissDialog) { setShowDismissDialog(false); e.preventDefault(); return; }
        if (showAdjustModal) { setShowAdjustModal(false); e.preventDefault(); return; }
        if (showDestructiveConfirm) { setShowDestructiveConfirm(null); e.preventDefault(); return; }
        return;
      }

      // Block all other shortcuts when a modal/input is active
      if (
        showAdjustModal ||
        showDestructiveConfirm ||
        showDismissDialog ||
        showShortcutsHelp ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable ||
        target.closest('[role="menu"]') ||
        target.closest('[role="dialog"]')
      )
        return;

      // ? — Show shortcuts help
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShowShortcutsHelp(true);
        return;
      }

      // Navigation: ArrowLeft / ArrowRight / j / k / ArrowDown / ArrowUp
      if (e.key === "ArrowLeft" || e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        navigate(-1);
      }
      if (e.key === "ArrowRight" || e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        navigate(1);
      }
      // Quick approve with 'a' (only if not already submitting)
      if (e.key === "a" && selectedItem?.type === "proposal" && !isSubmitting) {
        e.preventDefault();
        handleApprove();
      }
      // Quick dismiss with 'd' — opens dismiss reason dialog
      if (e.key === "d" && selectedItem?.type === "proposal" && !isSubmitting) {
        const gateOptions = selectedItem.data.gate_options as string[] | null;
        const showDismiss = !gateOptions || gateOptions.includes("DISMISS");
        if (showDismiss) {
          e.preventDefault();
          setShowDismissDialog(true);
        }
      }
      // Toggle queue list with 'l'
      if (e.key === "l") {
        e.preventDefault();
        setShowQueueList((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, showAdjustModal, showDestructiveConfirm, showDismissDialog, showShortcutsHelp, selectedItem, isSubmitting]);

  // ── Actions ────────────────────────────────

  // Optimistically remove current item from queue and advance to next.
  // Also removes the case's "other key" — when a proposal is acted on, the case
  // may reappear as a human_review item (or vice versa). Removing both keys
  // prevents the same case from bouncing back into the queue during revalidation.
  const removeCurrentItem = useCallback(() => {
    if (!selectedItem) return;
    const key = selectedItem.type === "proposal" ? `p:${selectedItem.data.id}` : `r:${selectedItem.data.id}`;
    const caseId = selectedItem.type === "proposal"
      ? (selectedItem.data as PendingProposal).case_id
      : selectedItem.data.id;
    setRemovedIds((prev) => {
      const next = new Set(prev);
      next.add(key);
      next.add(`r:${caseId}`); // prevent case reappearing as review item
      // Also remove all proposals for the same case (race condition prevention)
      if (overview?.pending_approvals) {
        for (const p of overview.pending_approvals) {
          if (p.case_id === caseId) next.add(`p:${p.id}`);
        }
      }
      return next;
    });
    // If we're at the end, move back; otherwise stay (next item slides in)
    if (currentIndex >= queue.length - 1 && currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [selectedItem, currentIndex, queue.length, overview]);

  // Background revalidate + clear removedIds once server data is fresh
  // Smart revalidate: fetch fresh data, then only keep removedIds that the server still returns
  // (items gone from server don't need filtering; items still present stay hidden)
  const revalidateQueue = useCallback(() => {
    mutate().then((freshData) => {
      if (!freshData) return;
      const serverIds = new Set<string>();
      for (const p of (freshData as LiveOverview).pending_approvals || []) serverIds.add(`p:${p.id}`);
      for (const r of (freshData as LiveOverview).human_review_cases || []) serverIds.add(`r:${r.id}`);
      setRemovedIds((prev) => {
        const next = new Set<string>();
        for (const id of prev) {
          if (serverIds.has(id)) next.add(id); // server still has it — keep filtering
        }
        return next;
      });
    });
  }, [mutate]);

  const handleApprove = async () => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    if (!canTakeAction) { showToast("Cannot take actions on another user's case", "error"); return; }
    const reviewText = getReviewInstructionText().trim();
    if (isEscalateProposal && !reviewText) {
      showToast("Provide instructions before approving this review item", "error");
      return;
    }
    setIsSubmitting(true);
    try {
      const body: Record<string, unknown> = { action: "APPROVE" };
      if (isEscalateProposal) {
        body.instruction = reviewText;
      }
      // Include any edits the user made to the draft
      if (editedBody && editedBody !== draftBody) body.draft_body_text = editedBody;
      if (editedSubject && editedSubject !== draftSubject) body.draft_subject = editedSubject;
      if (outboundAttachments.length > 0) body.attachments = outboundAttachments;
      if (editedRecipient && editedRecipient !== originalRecipient) body.recipient_override = editedRecipient;

      const res = await fetch(
        `/api/monitor/proposals/${selectedItem.data.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      removeCurrentItem();
      showToast("Approved — sending now");
      if (isEscalateProposal) setReviewInstruction("");
      revalidateQueue();
    } catch (err) {
      showToast(`Approve failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDismiss = (reason: string) => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    if (!canTakeAction) { showToast("Cannot take actions on another user's case", "error"); return; }
    const item = selectedItem;
    scheduleUndoableAction(
      `Dismissed: ${reason}`,
      item,
      async () => {
        const res = await fetch(
          `/api/monitor/proposals/${item.data.id}/decision`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "DISMISS", dismiss_reason: reason }),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || `Failed (${res.status})`);
        }
      },
    );
  };

  const handleAdjust = async () => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    if (!canTakeAction) { showToast("Cannot take actions on another user's case", "error"); return; }
    const adjustText = getAdjustInstructionText().trim();
    if (!adjustText) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(
        `/api/monitor/proposals/${selectedItem.data.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ADJUST",
            instruction: adjustText,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      setShowAdjustModal(false);
      setAdjustInstruction("");
      removeCurrentItem();
      showToast("Adjusted — AI is regenerating");
      revalidateQueue();
    } catch (err) {
      showToast(`Adjust failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRetryResearch = async () => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    setIsSubmitting(true);
    try {
      const res = await fetch(
        `/api/monitor/proposals/${selectedItem.data.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "RETRY_RESEARCH" }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      removeCurrentItem();
      showToast("Research retry started");
      revalidateQueue();
    } catch (err) {
      showToast(`Retry failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFeeWorkflowDecision = async (action: "ADD_TO_INVOICING" | "WAIT_FOR_GOOD_TO_PAY") => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    setIsSubmitting(true);
    try {
      const res = await fetch(
        `/api/monitor/proposals/${selectedItem.data.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      removeCurrentItem();
      showToast(action === "ADD_TO_INVOICING" ? "Added to invoicing" : "Waiting for good to pay");
      revalidateQueue();
    } catch (err) {
      showToast(`${getFeeDecisionLabel(action)} failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdraw = () => {
    if (!selectedItem) return;
    const caseId =
      selectedItem.type === "proposal"
        ? selectedItem.data.case_id
        : selectedItem.data.id;
    const item = selectedItem;
    setShowDestructiveConfirm({
      title: `Withdraw case #${caseId}?`,
      description: "This permanently closes the FOIA request. You have 5 seconds to undo after confirming.",
      onConfirm: () => {
        setShowDestructiveConfirm(null);
        scheduleUndoableAction(
          `Withdrawn: case #${caseId}`,
          item,
          async () => {
            const res = await fetch(`/api/requests/${caseId}/withdraw`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason: "Withdrawn from monitor queue" }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
              throw new Error(data.error || `Failed (${res.status})`);
            }
          },
        );
      },
    });
  };

  const handleMarkBugged = () => {
    if (!selectedItem) return;
    const caseId =
      selectedItem.type === "proposal"
        ? selectedItem.data.case_id
        : selectedItem.data.id;
    const item = selectedItem;
    setShowDestructiveConfirm({
      title: `Mark case #${caseId} as bugged?`,
      description: "This removes the case from the queue so you can investigate. You can re-add it once fixed.",
      onConfirm: () => {
        setShowDestructiveConfirm(null);
        scheduleUndoableAction(
          `Bugged: case #${caseId}`,
          item,
          async () => {
            const res = await fetch(`/api/requests/${caseId}/mark-bugged`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ description: "Marked as bugged from gated queue" }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
              throw new Error(data.error || `Failed (${res.status})`);
            }
          },
        );
      },
    });
  };

  const handleMatchToCase = async (messageId: number, caseId: number) => {
    try {
      const res = await fetch(`/api/monitor/message/${messageId}/match-case`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: caseId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      setMatchingMessageId(null);
      setManualCaseId("");
      mutateInbound();
    } catch (err) {
      showToast(`Match failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  };

  const openCorrespondence = async (caseId: number) => {
    // Toggle off if already showing
    if (showCorrespondence) {
      setShowCorrespondence(false);
      return;
    }
    setShowCorrespondence(true);
    setCorrespondenceLoading(true);
    setCorrespondenceMessages([]);
    try {
      const res = await fetch(`/api/requests/${caseId}/workspace`);
      const data = await res.json();
      if (data.success && data.thread_messages) {
        setCorrespondenceMessages([...data.thread_messages].reverse());
      }
    } catch (err) {
      console.error("Failed to load correspondence:", err);
    } finally {
      setCorrespondenceLoading(false);
    }
  };

  const handleMakePhoneCallFromQueue = (caseId: number) => {
    setAddCorrespondenceCaseId(caseId);
    setShowAddCorrespondenceDialog(true);
  };

  const handleResolveReview = async (action: string, instruction?: string) => {
    if (!selectedItem || selectedItem.type !== "review") return;
    if (!canTakeAction) { showToast("Cannot take actions on another user's case", "error"); return; }
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/requests/${selectedItem.data.id}/resolve-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, instruction: instruction || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      setReviewInstruction("");
      removeCurrentItem();
      showToast(data.message || `Resolved: ${action.replace(/_/g, " ")}`);
      revalidateQueue();
    } catch (err) {
      showToast(`Resolve failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Phone Queue Helpers ────────────────────

  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Cancel pending undoable action and restore item to queue
  const cancelPendingAction = useCallback(() => {
    if (!pendingAction) return;
    clearTimeout(pendingAction.timerId);
    const key = pendingAction.item.type === "proposal"
      ? `p:${pendingAction.item.data.id}`
      : `r:${pendingAction.item.data.id}`;
    const caseId = pendingAction.item.type === "proposal"
      ? (pendingAction.item.data as PendingProposal).case_id
      : pendingAction.item.data.id;
    const caseKey = `r:${caseId}`;
    setRemovedIds((prev) => {
      const next = new Set(prev);
      next.delete(key);
      next.delete(caseKey);
      return next;
    });
    setPendingAction(null);
    showToast("Action undone");
  }, [pendingAction, showToast]);

  // Schedule a destructive action with 5-second undo window
  const scheduleUndoableAction = useCallback((
    label: string,
    item: QueueItem,
    apiCall: () => Promise<void>,
  ) => {
    if (pendingAction) clearTimeout(pendingAction.timerId);
    const key = item.type === "proposal" ? `p:${item.data.id}` : `r:${item.data.id}`;
    const caseId = item.type === "proposal"
      ? (item.data as PendingProposal).case_id
      : item.data.id;
    const caseKey = `r:${caseId}`;
    setRemovedIds((prev) => {
      const next = new Set(prev);
      next.add(key);
      next.add(caseKey);
      return next;
    });
    if (currentIndex >= queue.length - 1 && currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
    const timerId = setTimeout(async () => {
      try {
        await apiCall();
        revalidateQueue();
      } catch (err) {
        showToast(`Failed: ${err instanceof Error ? err.message : err}`, "error");
        setRemovedIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          next.delete(caseKey);
          return next;
        });
      }
      setPendingAction(null);
    }, 5000);
    setPendingAction({ label, item, execute: apiCall, timerId, startedAt: Date.now() });
  }, [pendingAction, currentIndex, queue.length, revalidateQueue, showToast]);

  // ── Bulk actions ────────────────────────────
  const bulkProposals = useMemo(() =>
    queue.filter((i): i is QueueItem & { type: "proposal" } => i.type === "proposal"),
    [queue]
  );

  const toggleBulkSelect = (id: number) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleBulkSelectAll = () => {
    const allIds = bulkProposals.map((i) => i.data.id);
    const allSelected = allIds.length > 0 && allIds.every((id) => bulkSelected.has(id));
    if (allSelected) {
      setBulkSelected(new Set());
    } else {
      setBulkSelected(new Set(allIds));
    }
  };

  const handleBulkAction = async () => {
    if (!showBulkConfirm || bulkSelected.size === 0) return;
    if (showBulkConfirm.action === "DISMISS" && !showBulkConfirm.reason) {
      showToast("Please select a dismiss reason", "error");
      setShowBulkConfirm(null);
      return;
    }
    setBulkSubmitting(true);
    try {
      const res = await fetch("/api/monitor/proposals/bulk-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposal_ids: [...bulkSelected],
          action: showBulkConfirm.action,
          dismiss_reason: showBulkConfirm.reason || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);

      // Remove all acted-on items from queue
      setRemovedIds((prev) => {
        const next = new Set(prev);
        for (const id of bulkSelected) {
          next.add(`p:${id}`);
          const proposal = bulkProposals.find((p) => p.data.id === id);
          if (proposal) next.add(`r:${proposal.data.case_id}`);
        }
        return next;
      });

      const { succeeded, failed } = data.summary;
      showToast(
        failed > 0
          ? `${succeeded} ${showBulkConfirm.action.toLowerCase()}d, ${failed} failed`
          : `${succeeded} proposals ${showBulkConfirm.action.toLowerCase()}d`
      );
      setBulkSelected(new Set());
      setBulkMode(false);
      setShowBulkConfirm(null);
      setCurrentIndex(0);
      revalidateQueue();
    } catch (err) {
      showToast(`Bulk action failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setBulkSubmitting(false);
      setShowBulkConfirm(null);
    }
  };

  const handleAddToPhoneQueue = async (caseId: number, reason?: string) => {
    setAddingToPhoneQueue(true);
    try {
      const res = await fetch("/api/phone-calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case_id: caseId,
          reason: reason || "manual_add",
          notes: "Added from gated review queue",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      // Remove from queue and advance to next item
      removeCurrentItem();
      revalidateQueue();
      mutatePhone();
      if (data.already_exists) {
        showToast("Already in phone queue — moved to next item");
      } else {
        showToast("Added to phone queue — briefing generating...");
      }
    } catch (err) {
      showToast(`Failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setAddingToPhoneQueue(false);
    }
  };

  const handleCompletePhoneCall = async (taskId: number, outcome: string) => {
    setPhoneCallSubmitting(taskId);
    try {
      const res = await fetch(`/api/phone-calls/${taskId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          notes: callNotes || undefined,
          checked_points: Array.from(checkedPoints),
          completedBy: "dashboard",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      mutatePhone();
      if (data.stays_in_queue) {
        showToast(`${outcome.replace(/_/g, " ")} — call moved to bottom of queue`);
      } else {
        showToast(`Call completed: ${outcome.replace(/_/g, " ")}`);
        if (data.next_step) {
          setNextStepSuggestion(data.next_step);
        }
      }
      // Reset form
      setCallNotes("");
      setCallOutcome(null);
      setCheckedPoints(new Set());
    } catch (err) {
      showToast(`Complete failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setPhoneCallSubmitting(null);
    }
  };

  const handleSkipPhoneCall = async (taskId: number) => {
    setPhoneCallSubmitting(taskId);
    try {
      const res = await fetch(`/api/phone-calls/${taskId}/skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: "Skipped from dashboard" }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      mutatePhone();
      showToast("Call skipped");
    } catch (err) {
      showToast(`Skip failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setPhoneCallSubmitting(null);
    }
  };

  const handleFindPhoneNumber = async (taskId: number) => {
    setPhoneCallSubmitting(taskId);
    try {
      const res = await fetch(`/api/phone-calls/${taskId}/find-phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      mutatePhone();
      if (data.found) {
        showToast(`Found: ${data.phone}`);
      } else {
        showToast("No phone number found from any source", "error");
      }
    } catch (err) {
      showToast(`Lookup failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setPhoneCallSubmitting(null);
    }
  };

  // ── Extract display data ───────────────────

  const summary = overview?.summary;

  // Tab title badge — use local count so it updates instantly on actions
  useEffect(() => {
    document.title = localTotalAttention > 0 ? `(${localTotalAttention}) AUTOBOT` : "AUTOBOT";
  }, [localTotalAttention]);

  // For the selected proposal: use detail data if available, fallback to overview data
  const draftBody = (() => {
    if (selectedItem?.type !== "proposal") return null;
    // Try detail first
    if (proposalDetail?.proposal?.draft_body_text) return proposalDetail.proposal.draft_body_text;
    // Fallback to overview data
    return selectedItem.data.draft_body_text || selectedItem.data.draft_body || null;
  })();

  const draftSubject = (() => {
    if (selectedItem?.type !== "proposal") return null;
    if (proposalDetail?.proposal?.draft_subject) return proposalDetail.proposal.draft_subject;
    return selectedItem.data.draft_subject || null;
  })();

  const originalRecipient = selectedItem?.type === "proposal"
    ? (selectedItem.data.effective_agency_email || selectedItem.data.agency_email || "")
    : "";

  // Keep edited draft in sync when a new item is selected or draft loads
  useEffect(() => {
    setEditedBody(draftBody || "");
    setEditedSubject(draftSubject || "");
    setEditedRecipient(originalRecipient);
    setOutboundAttachments([]);
    setReasoningExpanded(false);
  }, [draftBody, draftSubject, originalRecipient]);

  const reasoning = (() => {
    if (selectedItem?.type !== "proposal") return [];
    if (proposalDetail?.proposal?.reasoning) return proposalDetail.proposal.reasoning;
    return formatReasoning(selectedItem.data.reasoning);
  })();
  const escalationRequestedAction =
    selectedItem?.type === "proposal" && selectedItem.data.action_type === "ESCALATE"
      ? extractEscalationRequestedAction(reasoning)
      : null;
  const manualPdfEscalation =
    selectedItem?.type === "proposal" && selectedItem.data.action_type === "ESCALATE"
      ? extractManualPdfEscalation(reasoning)
      : null;

  const INTERNAL_FLAGS = new Set(["NO_DRAFT", "MISSING_DRAFT", "DRAFT_EMPTY"]);
  const riskFlags = (() => {
    if (selectedItem?.type !== "proposal") return [];
    const detailFlags = proposalDetail?.proposal?.risk_flags;
    const overviewFlags = selectedItem.data.risk_flags;
    const raw = (detailFlags && detailFlags.length > 0 ? detailFlags : overviewFlags) || [];
    // Deduplicate + filter internal flags
    return [...new Set(raw)].filter((f: string) => !INTERNAL_FLAGS.has(f));
  })();

  const warnings = (() => {
    if (selectedItem?.type !== "proposal") return [];
    const detailWarnings = proposalDetail?.proposal?.warnings;
    const overviewWarnings = selectedItem.data.warnings;
    return (detailWarnings && detailWarnings.length > 0 ? detailWarnings : overviewWarnings) || [];
  })();

  const classification = proposalDetail?.proposal?.analysis?.classification ?? null;
  const sentiment = proposalDetail?.proposal?.analysis?.sentiment ?? null;
  const feeAmount = proposalDetail?.proposal?.analysis?.extracted_fee_amount ?? null;

  // ── Render ─────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[80vh] text-sm text-destructive">
        Failed to load: {error.message}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── Stats Bar ──────────────────────── */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-6">
        <StatBox
          label="Attention"
          value={localTotalAttention}
          icon={AlertCircle}
          color={localTotalAttention > 0 ? "text-amber-400" : "text-green-400"}
          onClick={() => { setActiveTab("queue"); setQueueFilter("all"); setCurrentIndex(0); }}
          active={activeTab === "queue" && queueFilter === "all"}
        />
        <StatBox
          label="Proposals"
          value={localProposalCount}
          icon={FileText}
          color="text-blue-400"
          onClick={() => { setActiveTab("queue"); setQueueFilter("proposals"); setCurrentIndex(0); }}
          active={activeTab === "queue" && queueFilter === "proposals"}
        />
        <StatBox
          label="Review"
          value={localReviewCount}
          icon={Shield}
          color="text-purple-400"
          onClick={() => { setActiveTab("queue"); setQueueFilter("reviews"); setCurrentIndex(0); }}
          active={activeTab === "queue" && queueFilter === "reviews"}
        />
        <StatBox
          label="Inbound 24h"
          value={summary?.inbound_24h ?? 0}
          icon={Mail}
          color="text-green-400"
          onClick={() => setActiveTab("inbound")}
          active={activeTab === "inbound"}
        />
        <StatBox
          label="Unmatched"
          value={summary?.unmatched_inbound_total ?? 0}
          icon={AlertTriangle}
          color={
            (summary?.unmatched_inbound_total ?? 0) > 0
              ? "text-orange-400"
              : "text-muted-foreground"
          }
          onClick={() => setActiveTab("inbound")}
          active={activeTab === "inbound"}
        />
        <StatBox
          label="Active Runs"
          value={summary?.active_runs_total ?? 0}
          icon={Activity}
          color="text-muted-foreground"
        />
      </div>

      {/* ── System Health (admin only) ──────────────────── */}
      {isAdmin && healthData?.metrics && (
        <Collapsible className="mb-4">
          <CollapsibleTrigger className="w-full">
            <div className={cn(
              "flex items-center justify-between px-3 py-2 border text-xs",
              healthData.total_issues > 0 ? "border-red-800 bg-red-950/30" : "border-green-800 bg-green-950/30"
            )}>
              <div className="flex items-center gap-2">
                {healthData.total_issues > 0 ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
                ) : (
                  <CheckCircle className="h-3.5 w-3.5 text-green-400" />
                )}
                <span className={healthData.total_issues > 0 ? "text-red-400" : "text-green-400"}>
                  {healthData.total_issues > 0
                    ? `${healthData.total_issues} system issue${healthData.total_issues > 1 ? "s" : ""}`
                    : "System healthy"}
                </span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-border border border-t-0">
              {[
                ...(healthData.metrics.stuck_breakdown && healthData.metrics.stuck_cases > 0
                  ? [
                      { label: "Stuck: review", value: healthData.metrics.stuck_breakdown.needs_human_review, metric: "stuck_cases" as HealthMetricKey },
                      { label: "Stuck: phone", value: healthData.metrics.stuck_breakdown.needs_phone_call, metric: "stuck_cases" as HealthMetricKey },
                      { label: "Stuck: contact", value: healthData.metrics.stuck_breakdown.needs_contact_info, metric: "stuck_cases" as HealthMetricKey },
                      { label: "Stuck: fee", value: healthData.metrics.stuck_breakdown.needs_human_fee_approval, metric: "stuck_cases" as HealthMetricKey },
                      { label: "Stuck: research handoff", value: healthData.metrics.stuck_breakdown.research_handoff, metric: "stuck_cases" as HealthMetricKey },
                    ].filter(m => m.value > 0)
                  : [{ label: "Stuck cases", value: healthData.metrics.stuck_cases, metric: "stuck_cases" as HealthMetricKey }]
                ),
                { label: "Orphaned runs", value: healthData.metrics.orphaned_runs, metric: "orphaned_runs" as HealthMetricKey },
                { label: "Stale proposals", value: healthData.metrics.stale_proposals, metric: "stale_proposals" as HealthMetricKey },
                { label: "Overdue deadlines", value: healthData.metrics.overdue_deadlines, metric: "overdue_deadlines" as HealthMetricKey },
                { label: "Bounced emails (24h)", value: healthData.metrics.bounced_emails, metric: "bounced_emails" as HealthMetricKey },
                { label: "Portal failures (24h)", value: healthData.metrics.portal_failures, metric: "portal_failures" as HealthMetricKey },
                { label: "Inbound linkage gaps", value: healthData.metrics.inbound_linkage_gaps, metric: "inbound_linkage_gaps" as HealthMetricKey },
                { label: "Empty normalized inbound", value: healthData.metrics.empty_normalized_inbound, metric: "empty_normalized_inbound" as HealthMetricKey },
                { label: "Proposal/message mismatches", value: healthData.metrics.proposal_message_mismatches, metric: "proposal_message_mismatches" as HealthMetricKey },
              ].map((m) => (
                <div
                  key={m.label}
                  className={cn(
                    "bg-card px-3 py-2",
                    m.value > 0 && "cursor-pointer hover:bg-muted/50",
                    expandedHealthMetric === m.metric && "ring-1 ring-inset ring-foreground/30 bg-muted/40",
                  )}
                  onClick={m.value > 0 ? () => setExpandedHealthMetric(expandedHealthMetric === m.metric ? null : m.metric) : undefined}
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    {m.label}
                    {m.value > 0 && <ChevronRight className={cn("h-2.5 w-2.5 transition-transform", expandedHealthMetric === m.metric && "rotate-90")} />}
                  </div>
                  <div className={cn(
                    "text-lg font-bold tabular-nums",
                    m.value > 0 ? "text-red-400" : "text-green-400"
                  )}>
                    {m.value}
                  </div>
                </div>
              ))}
            </div>
            {expandedHealthMetric && (
              <HealthMetricDetail
                metric={expandedHealthMetric}
                onClose={() => setExpandedHealthMetric(null)}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* ── Tab Bar ─────────────────────────── */}
      <div className="flex items-center gap-0 border-b mb-4">
        {([
          { id: "queue" as TabId, label: "QUEUE", icon: AlertCircle, count: localTotalAttention },
          { id: "inbound" as TabId, label: "INBOUND", icon: Mail, count: inboundData?.count },
          { id: "calls" as TabId, label: "PHONE CALLS", icon: Phone, count: phoneData?.stats?.pending },
        ]).map((tab) => {
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2 text-[10px] uppercase tracking-widest transition-colors border-b-2 -mb-px",
                activeTab === tab.id
                  ? "text-foreground border-foreground"
                  : "text-muted-foreground border-transparent hover:text-foreground"
              )}
            >
              <TabIcon className="h-3 w-3" />
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <Badge variant="outline" className="h-4 px-1 text-[10px] leading-none ml-1">
                  {tab.count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Case not found banner ──────────── */}
      {caseNotFoundId && (
        <div className="border border-amber-700/50 bg-amber-950/20 px-3 py-2 mb-4 flex items-center justify-between">
          <p className="text-xs text-amber-400">
            Case #{caseNotFoundId} is not in the current queue. Showing first available item.
          </p>
          <button onClick={() => setCaseNotFoundId(null)} className="text-xs text-muted-foreground hover:text-foreground ml-4">
            Dismiss
          </button>
        </div>
      )}

      {/* ── Queue Tab ────────────────────────── */}
      {activeTab === "queue" && (<>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            Needs Attention
          </span>
          {queue.length > 0 && (
            <Badge variant="outline" className="text-xs tabular-nums">
              {safeIndex + 1} / {queue.length}
            </Badge>
          )}
          <Badge
            variant={sseConnected ? "outline" : "destructive"}
            className={cn(
              "text-[10px]",
              sseConnected && "text-green-400 border-green-700/50"
            )}
          >
            <Radio className="h-2.5 w-2.5 mr-1" />
            {sseConnected ? "LIVE" : "OFFLINE"}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {!bulkMode && (<>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(-1)}
              disabled={queue.length <= 1}
              title="Previous (←)"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(1)}
              disabled={queue.length <= 1}
              title="Next (→)"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <div className="w-px h-4 bg-border mx-1" />
          </>)}
          {bulkProposals.length > 1 && (
            <Button
              variant={bulkMode ? "default" : "ghost"}
              size="sm"
              onClick={() => { setBulkMode(!bulkMode); setBulkSelected(new Set()); }}
              title="Bulk select mode"
            >
              <ListChecks className="h-3.5 w-3.5 mr-1" />
              {bulkMode ? "Exit Bulk" : "Bulk"}
            </Button>
          )}
          {!bulkMode && (<>
            <Button
              variant={showQueueList ? "default" : "ghost"}
              size="sm"
              onClick={() => setShowQueueList(!showQueueList)}
              title="Toggle queue list (l)"
            >
              <Activity className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => mutate()} title="Refresh">
              <RefreshCw className="h-3 w-3" />
            </Button>
          </>)}
        </div>
      </div>

      {/* ── Compact Queue List ────────────────── */}
      {showQueueList && queue.length > 0 && !bulkMode && (
        <div className="mb-3 border rounded bg-card max-h-[200px] overflow-y-auto">
          {queue.map((item, idx) => {
            const isActive = idx === safeIndex;
            const caseId = item.type === "proposal" ? item.data.case_id : item.data.id;
            const agency = item.type === "proposal"
              ? deriveDisplayAgencyName(item.data)
              : (item.data as HumanReviewCase).agency_name || "Unknown";
            const actionLabel = item.type === "proposal"
              ? (ACTION_LABELS[(item.data as PendingProposal).action_type] || (item.data as PendingProposal).action_type?.replace(/_/g, " "))
              : (item.data as HumanReviewCase).status?.replace(/_/g, " ");
            return (
              <button
                key={item.type === "proposal" ? `p:${item.data.id}` : `r:${item.data.id}`}
                className={cn(
                  "w-full text-left px-2 py-1 text-[10px] flex items-center gap-2 border-b border-border/30 last:border-b-0 transition-colors",
                  isActive ? "bg-muted/60" : "hover:bg-muted/30"
                )}
                onClick={() => setCurrentIndex(idx)}
              >
                <span className="text-muted-foreground font-mono shrink-0 w-6 text-right">{idx + 1}.</span>
                <span className="text-muted-foreground font-mono shrink-0">#{caseId}</span>
                {item.type === "proposal" && (
                  <span className="text-muted-foreground/50 font-mono shrink-0">P{item.data.id}</span>
                )}
                <span className="truncate flex-1">{agency}</span>
                <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 h-3.5">
                  {actionLabel}
                </Badge>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Bulk Select Mode ─────────────────── */}
      {bulkMode && bulkProposals.length > 0 && (
        <div className="space-y-3 mb-4">
          {/* Bulk action bar */}
          <div className="flex items-center justify-between border bg-card px-3 py-2">
            <div className="flex items-center gap-3">
              <button
                onClick={toggleBulkSelectAll}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {bulkSelected.size === bulkProposals.length && bulkProposals.length > 0
                  ? <CheckSquare className="h-3.5 w-3.5" />
                  : <Square className="h-3.5 w-3.5" />}
                {bulkSelected.size === bulkProposals.length ? "Deselect All" : "Select All"}
              </button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {bulkSelected.size} of {bulkProposals.length} selected
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="default"
                className="bg-green-600 hover:bg-green-700 text-white h-7 text-xs"
                disabled={bulkSelected.size === 0 || bulkSubmitting}
                onClick={() => setShowBulkConfirm({ action: "APPROVE" })}
              >
                <CheckCircle className="h-3 w-3 mr-1" />
                Approve {bulkSelected.size > 0 ? `(${bulkSelected.size})` : ""}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={bulkSelected.size === 0 || bulkSubmitting}
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    Dismiss {bulkSelected.size > 0 ? `(${bulkSelected.size})` : ""}
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {DISMISS_REASONS.map((reason) => (
                    <DropdownMenuItem
                      key={reason}
                      onClick={() => setShowBulkConfirm({ action: "DISMISS", reason })}
                    >
                      {reason}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Compact list of proposals */}
          <div className="border divide-y max-h-[60vh] overflow-y-auto">
            {bulkProposals.map((item) => {
              const p = item.data;
              const isSelected = bulkSelected.has(p.id);
              return (
                <div
                  key={p.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors",
                    isSelected ? "bg-muted/50" : "hover:bg-muted/30"
                  )}
                  onClick={() => toggleBulkSelect(p.id)}
                >
                  <Checkbox
                    checked={isSelected}
                    className="h-4 w-4 pointer-events-none"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-mono text-muted-foreground">#{p.case_id}</span>
                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                        {p.action_type.replace(/_/g, " ")}
                      </Badge>
                      {p.confidence != null && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] px-1 py-0",
                            p.confidence >= 0.8
                              ? "text-green-400 border-green-700/50"
                              : p.confidence >= 0.5
                              ? "text-yellow-400 border-yellow-700/50"
                              : "text-red-400 border-red-700/50"
                          )}
                        >
                          {Math.round(p.confidence * 100)}%
                        </Badge>
                      )}
                      {(() => {
                        const dl = p.deadline_date;
                        if (!dl) return null;
                        const daysUntil = Math.ceil((new Date(dl).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                        if (daysUntil > 3) return null;
                        return (
                          <Badge variant="destructive" className="text-[10px] px-1 py-0">
                            {daysUntil <= 0 ? "OVERDUE" : "URGENT"}
                          </Badge>
                        );
                      })()}
                      {p.risk_flags && p.risk_flags.filter(f => !["NO_DRAFT", "MISSING_DRAFT", "DRAFT_EMPTY"].includes(f)).length > 0 && (
                        <AlertTriangle className="h-3 w-3 text-amber-400" />
                      )}
                    </div>
                    <p className="text-xs truncate mt-0.5">
                      {p.case_name || "Unnamed Case"}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {p.agency_name} {"\u00B7"} {formatRelativeTime(p.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Empty State ────────────────────── */}
      {queue.length === 0 && !bulkMode && (
        <div className="flex flex-col items-center justify-center h-[50vh] gap-4">
          <CheckCircle className="h-10 w-10 text-green-500" />
          <p className="text-sm text-muted-foreground">
            Queue empty. No items need attention.
          </p>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-3 w-3 mr-1.5" /> Refresh
          </Button>
        </div>
      )}

      {/* ── Proposal View ──────────────────── */}
      {selectedItem?.type === "proposal" && !bulkMode && (
        <div className="space-y-4">
          {/* Case header */}
          <div className="border-b pb-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-mono">
                    #{selectedItem.data.case_id}
                  </span>
                  <span className="text-[10px] text-muted-foreground/50 font-mono">
                    P{selectedItem.data.id}
                  </span>
                  <h2 className="text-sm font-semibold">
                    {selectedItem.data.case_name || "Unnamed Case"}
                  </h2>
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-xs text-muted-foreground">
                    {deriveDisplayAgencyName(selectedItem.data)}
                  </span>
                  {selectedItem.data.user_id && (
                    <Badge variant="outline" className="text-[10px] text-cyan-400 border-cyan-700/50">
                      {userNameMap[selectedItem.data.user_id] || `User #${selectedItem.data.user_id}`}
                    </Badge>
                  )}
                  {!canTakeAction && (
                    <Badge variant="destructive" className="text-[10px]">
                      View only — {userNameMap[caseOwnerId!] || "another user"}&apos;s case
                    </Badge>
                  )}
                  {getPauseReason(selectedItem) && (
                    <Badge variant="outline" className="text-[10px]">
                      {PAUSE_LABELS[getPauseReason(selectedItem)!] || getPauseReason(selectedItem)}
                    </Badge>
                  )}
                  {classification && (
                    <Badge variant="outline" className="text-[10px]">
                      {classification}
                    </Badge>
                  )}
                  {sentiment && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        sentiment === "HOSTILE" && "text-red-400 border-red-700/50"
                      )}
                    >
                      {sentiment}
                    </Badge>
                  )}
                  {selectedItem.data.confidence != null && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        selectedItem.data.confidence >= 0.8
                          ? "text-green-400 border-green-700/50"
                          : selectedItem.data.confidence >= 0.5
                          ? "text-yellow-400 border-yellow-700/50"
                          : "text-red-400 border-red-700/50"
                      )}
                    >
                      {Math.round(selectedItem.data.confidence * 100)}% conf
                    </Badge>
                  )}
                  {(() => {
                    const dl = selectedItem.data.deadline_date;
                    if (!dl) return null;
                    const daysUntil = Math.ceil((new Date(dl).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    if (daysUntil > 3) return null;
                    return (
                      <Badge variant="destructive" className="text-[10px]">
                        {daysUntil <= 0 ? "OVERDUE" : "URGENT"}
                      </Badge>
                    );
                  })()}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openCorrespondence(selectedItem.data.case_id)}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <MessageSquare className="h-3 w-3" /> Thread
                </button>
                <Link
                  href={`/requests/detail-v2?id=${selectedItem.data.case_id}`}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" /> Case
                </Link>
                <Badge variant="outline" className="text-[10px]">
                  <Clock className="h-2.5 w-2.5 mr-1" />
                  {formatRelativeTime(selectedItem.data.created_at)}
                </Badge>
              </div>
            </div>
          </div>

          {/* Action type + confidence */}
          <div className="flex items-center gap-3 flex-wrap">
            <SectionLabel>Action</SectionLabel>
            <Badge variant="outline" className="text-xs">
              {selectedItem.data.action_type?.replace(/_/g, " ")}
            </Badge>
            {selectedItem.data.confidence != null && (
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    selectedItem.data.confidence >= 0.8
                      ? "bg-green-500"
                      : selectedItem.data.confidence >= 0.6
                      ? "bg-yellow-500"
                      : "bg-red-500"
                  )}
                />
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Math.round(selectedItem.data.confidence * 100)}%
                </span>
              </span>
            )}
            {feeAmount != null && (
              <Badge variant="outline" className="text-[10px] text-yellow-400 border-yellow-700/50">
                ${Number(feeAmount).toFixed(2)} fee
              </Badge>
            )}
          </div>

          {/* AI Summary — structured at-a-glance panel */}
          <div className="border border-blue-700/30 bg-blue-950/15 p-3 space-y-2">
            <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider flex items-center gap-1">
              <Brain className="h-3 w-3" /> AI Summary
            </p>
            <div className="text-xs space-y-1.5">
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0 w-[70px]">Decision:</span>
                <span className="font-medium">
                  {selectedItem.data.action_type?.replace(/_/g, " ")}
                  {selectedItem.data.confidence != null && (
                    <span className={cn(
                      "ml-1.5",
                      selectedItem.data.confidence >= 0.8 ? "text-green-400" :
                      selectedItem.data.confidence >= 0.6 ? "text-amber-400" : "text-red-400"
                    )}>
                      ({Math.round(selectedItem.data.confidence * 100)}% confident)
                    </span>
                  )}
                </span>
              </div>
              {reasoning.length > 0 && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">Reason:</span>
                  <div className="text-foreground/80">
                    <span>{formatReasoningItem(reasoning[0])}</span>
                    {reasoning.length > 1 && (
                      <div className="mt-1 space-y-0.5">
                        {reasoning.slice(1).map((r, i) => (
                          <p key={i} className="text-foreground/60 text-[11px]">• {formatReasoningItem(r)}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {selectedItem.data.case_substatus && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">Status:</span>
                  <span className="text-foreground/80">{humanizeSubstatus(selectedItem.data.case_substatus)}</span>
                </div>
              )}
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0 w-[70px]">Next step:</span>
                <span className="text-foreground/80">
                  {draftBody ? "Review the draft below and approve, adjust, or dismiss." :
                   selectedItem.data.action_type === "SUBMIT_PORTAL" ? "Approve to submit via portal, or dismiss." :
                   selectedItem.data.action_type === "CLOSE_CASE" ? "Confirm closure or dismiss to keep case open." :
                   selectedItem.data.action_type === "ESCALATE" ? "Review context and take manual action." :
                   "Choose an action below."}
                </span>
              </div>
            </div>
          </div>

          {/* Trigger message preview — what email triggered this proposal */}
          {selectedItem.data.trigger_message && (
            <div className="border border-border bg-muted/30 p-2.5 space-y-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Mail className="h-3 w-3" /> Trigger Email
              </p>
              <div className="text-xs space-y-0.5">
                {selectedItem.data.trigger_message.from_email && (
                  <p className="text-muted-foreground truncate">
                    <span className="text-muted-foreground/70">From:</span>{" "}
                    {selectedItem.data.trigger_message.from_email}
                  </p>
                )}
                {selectedItem.data.trigger_message.subject && (
                  <p className="text-muted-foreground truncate">
                    <span className="text-muted-foreground/70">Subj:</span>{" "}
                    {selectedItem.data.trigger_message.subject.length > 60
                      ? selectedItem.data.trigger_message.subject.slice(0, 60) + "..."
                      : selectedItem.data.trigger_message.subject}
                  </p>
                )}
                {selectedItem.data.trigger_message.body_preview && (
                  <p className="text-muted-foreground/60 truncate">
                    {selectedItem.data.trigger_message.body_preview.length > 100
                      ? selectedItem.data.trigger_message.body_preview.slice(0, 100) + "..."
                      : selectedItem.data.trigger_message.body_preview}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Delivery method — show for non-email actionable proposals (portal/close/escalate) */}
          {selectedItem.data.action_type && !selectedItem.data.action_type.startsWith("SEND") && (
            <div className={cn(
              "border p-3",
              selectedItem.data.action_type === "SUBMIT_PORTAL"
                ? "border-blue-700/50 bg-blue-950/20"
                : "border-zinc-700/50 bg-zinc-950/20"
            )}>
              <SectionLabel>
                {selectedItem.data.action_type === "SUBMIT_PORTAL" ? "Delivery: Portal" :
                 selectedItem.data.action_type === "CLOSE_CASE" ? "Action: Close Case" :
                 selectedItem.data.action_type === "ESCALATE" ? "Human Action Needed" :
                 "Action"}
              </SectionLabel>
              {selectedItem.data.action_type === "SUBMIT_PORTAL" && (
                <div className="space-y-3">
                  {(portalHelper?.portal_url || selectedItem.data.portal_url) ? (
                    <Button
                      size="sm"
                      className="bg-cyan-700 hover:bg-cyan-600 text-white h-7 text-xs"
                      onClick={() => window.open(portalHelper?.portal_url || selectedItem.data.portal_url, "_blank")}
                    >
                      <ExternalLink className="h-3 w-3 mr-1.5" /> Open Portal
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">No portal URL on file</p>
                  )}
                  {portalHelper ? (() => {
                    const CopyRow = ({ label, value, fieldKey }: { label: string; value: string | null | undefined; fieldKey: string }) => {
                      if (!value) return null;
                      return (
                        <div className="flex items-center justify-between gap-2 py-0.5">
                          <div className="min-w-0">
                            <span className="text-[10px] text-muted-foreground">{label}:</span>{" "}
                            <span className="text-xs text-foreground/90 break-all">{value}</span>
                          </div>
                          <Button size="sm" variant="ghost" className="h-5 w-5 p-0 shrink-0" onClick={() => { navigator.clipboard.writeText(value); }}>
                            <Copy className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        </div>
                      );
                    };
                    return (
                      <div className="space-y-2 border border-cyan-800/40 bg-cyan-950/20 rounded p-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <Globe className="h-4 w-4 text-cyan-400" />
                          <span className="font-medium text-cyan-300">Manual Portal Submission</span>
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Requester</p>
                          <CopyRow label="Name" value={portalHelper.requester.name} fieldKey="ph-name" />
                          <CopyRow label="Email" value={portalHelper.requester.email} fieldKey="ph-email" />
                          <CopyRow label="Phone" value={portalHelper.requester.phone} fieldKey="ph-phone" />
                          <CopyRow label="Organization" value={portalHelper.requester.organization} fieldKey="ph-org" />
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Address</p>
                          <CopyRow label="Street" value={portalHelper.address.line1} fieldKey="ph-street" />
                          {portalHelper.address.line2 && <CopyRow label="Line 2" value={portalHelper.address.line2} fieldKey="ph-line2" />}
                          <CopyRow label="City" value={portalHelper.address.city} fieldKey="ph-city" />
                          <CopyRow label="State" value={portalHelper.address.state} fieldKey="ph-state" />
                          <CopyRow label="ZIP" value={portalHelper.address.zip} fieldKey="ph-zip" />
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Case Info</p>
                          <CopyRow label="Subject" value={portalHelper.case_info.subject_name} fieldKey="ph-subject" />
                          <CopyRow label="Incident Date" value={portalHelper.case_info.incident_date} fieldKey="ph-date" />
                          {portalHelper.case_info.requested_records?.length > 0 && (
                            <CopyRow label="Records" value={portalHelper.case_info.requested_records.join(", ")} fieldKey="ph-records" />
                          )}
                          {portalHelper.case_info.additional_details && !isRawImportDump(portalHelper.case_info.additional_details) && (
                            <CopyRow label="Details" value={portalHelper.case_info.additional_details} fieldKey="ph-details" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => {
                            const lines = [
                              `Name: ${portalHelper.requester.name}`,
                              `Email: ${portalHelper.requester.email}`,
                              `Phone: ${portalHelper.requester.phone}`,
                              portalHelper.requester.organization && `Organization: ${portalHelper.requester.organization}`,
                              `Address: ${portalHelper.address.line1}, ${portalHelper.address.city}, ${portalHelper.address.state} ${portalHelper.address.zip}`,
                              portalHelper.case_info.subject_name && `Subject: ${portalHelper.case_info.subject_name}`,
                              portalHelper.case_info.incident_date && `Date: ${portalHelper.case_info.incident_date}`,
                              portalHelper.case_info.requested_records?.length > 0 && `Records: ${portalHelper.case_info.requested_records.join(", ")}`,
                              portalHelper.case_info.additional_details && !isRawImportDump(portalHelper.case_info.additional_details) && `Details: ${portalHelper.case_info.additional_details}`,
                            ].filter(Boolean).join("\n");
                            navigator.clipboard.writeText(lines);
                          }}>
                            <Copy className="h-3 w-3 mr-1" /> Copy All
                          </Button>
                        </div>
                      </div>
                    );
                  })() : (
                    <p className="text-[10px] text-muted-foreground">Loading portal fields...</p>
                  )}
                </div>
              )}
              {selectedItem.data.action_type === "CLOSE_CASE" && (
                <p className="text-xs text-muted-foreground">Will mark this case as closed/denial accepted.</p>
              )}
              {selectedItem.data.action_type === "ESCALATE" && (
                <div className="space-y-1.5">
                  {manualPdfEscalation ? (
                    <div className="space-y-1.5 text-xs">
                      <p className="text-amber-200">
                        Automatic PDF completion failed. Complete the attached{" "}
                        <span className="font-medium">
                          {manualPdfEscalation.attachmentName || "request form PDF"}
                        </span>{" "}
                        manually and send it to the agency.
                      </p>
                      {(selectedItem.data.effective_agency_email || selectedItem.data.agency_email) && (
                        <p>
                          <span className="text-muted-foreground">Send to:</span>{" "}
                          <span className="font-medium">
                            {selectedItem.data.effective_agency_email || selectedItem.data.agency_email}
                          </span>
                        </p>
                      )}
                      {manualPdfEscalation.failureReason && (
                        <p>
                          <span className="text-muted-foreground">Failure:</span>{" "}
                          {manualPdfEscalation.failureReason}
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">Review the reasoning below and choose an action — approve, adjust, or dismiss.</p>
                      <div className="text-xs space-y-1">
                        {escalationRequestedAction && (
                          <p>
                            <span className="text-muted-foreground">Requested action:</span>{" "}
                            <span className="font-medium">{escalationRequestedAction.replace(/_/g, " ")}</span>
                          </p>
                        )}
                        {selectedItem.data.case_status && (
                          <p>
                            <span className="text-muted-foreground">Case status:</span>{" "}
                            {selectedItem.data.case_status.replace(/_/g, " ")}
                          </p>
                        )}
                        {selectedItem.data.case_substatus && (
                          <p>
                            <span className="text-muted-foreground">Case substatus:</span>{" "}
                            {humanizeSubstatus(selectedItem.data.case_substatus)}
                          </p>
                        )}
                        {!selectedItem.data.last_inbound_preview && (
                          <p className="text-amber-400">
                            No inbound message context is attached to this proposal.
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Reasoning details collapsed into AI Summary above */}

          {/* Inbound message — collapsed by default */}
          {selectedItem.data.last_inbound_preview && (
            <Collapsible>
              <div className="border p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <SectionLabel>Inbound</SectionLabel>
                    {selectedItem.data.last_inbound_subject && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">
                        {selectedItem.data.last_inbound_subject}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <CollapsibleTrigger asChild>
                      <button className="text-[10px] text-primary hover:underline">
                        Show
                      </button>
                    </CollapsibleTrigger>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => openCorrespondence(selectedItem.data.case_id)}
                    >
                      <MessageSquare className="h-3 w-3 mr-1" />
                      {showCorrespondence ? "Hide" : "Full Thread"}
                    </Button>
                  </div>
                </div>
                <CollapsibleContent>
                  {selectedItem.data.last_inbound_subject && (
                    <p className="text-xs mb-1.5 mt-2">
                      <span className="text-muted-foreground">Subj:</span>{" "}
                      {selectedItem.data.last_inbound_subject}
                    </p>
                  )}
                  {(() => {
                    const { body: inboundClean, quotedThread: inboundQuoted } = cleanEmailBody(selectedItem.data.last_inbound_preview || "");
                    return (
                      <div className="bg-background border p-2 mt-1.5">
                        <LinkifiedText
                          text={inboundClean}
                          className="text-xs whitespace-pre-wrap font-[inherit] text-foreground/80"
                        />
                        {inboundQuoted && (
                          <details className="mt-2 border-t border-border/50 pt-2">
                            <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                              Show full thread
                            </summary>
                            <div className="mt-1.5 pl-2 border-l-2 border-muted">
                              <LinkifiedText
                                text={inboundQuoted}
                                className="text-xs whitespace-pre-wrap font-[inherit] text-muted-foreground/60"
                              />
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })()}
                </CollapsibleContent>
              </div>
            </Collapsible>
          )}

          {/* Inbound attachments — right after inbound message */}
          {(() => {
            const inbound = (selectedItem.data.attachments || []).filter((a) => a.direction !== 'outbound');
            if (inbound.length === 0) return null;
            return (
              <div className="border border-blue-800/40 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <SectionLabel>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-blue-500" />
                      Inbound Attachments
                    </span>
                  </SectionLabel>
                  <Badge variant="outline" className="text-[10px] text-blue-400 border-blue-700/50">
                    {inbound.length} received
                  </Badge>
                </div>
                <div className="space-y-1.5">
                  {inbound.map((att) => (
                    <a
                      key={att.id}
                      href={att.download_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between border bg-background px-2 py-1.5 text-xs hover:bg-muted/40"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Paperclip className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">{att.filename || `Attachment #${att.id}`}</span>
                      </span>
                      <span className="text-muted-foreground ml-2 flex-shrink-0">
                        {att.size_bytes ? `${Math.max(1, Math.round(att.size_bytes / 1024))} KB` : "file"}
                      </span>
                    </a>
                  ))}
                </div>
                {selectedItem.data.attachment_insights && (
                  <div className="space-y-1.5 pt-1">
                    {(selectedItem.data.attachment_insights.fee_amounts || []).length > 0 && (
                      <div className="text-xs text-foreground/90 flex items-center gap-1.5">
                        <DollarSign className="h-3 w-3 text-amber-400" />
                        Fee mentions: {selectedItem.data.attachment_insights.fee_amounts.map((n) => `$${n.toFixed(2)}`).join(", ")}
                      </div>
                    )}
                    {(selectedItem.data.attachment_insights.deadline_mentions || []).length > 0 && (
                      <div className="text-xs text-foreground/90 flex items-center gap-1.5">
                        <CalendarDays className="h-3 w-3 text-blue-400" />
                        Date mentions: {selectedItem.data.attachment_insights.deadline_mentions.slice(0, 3).join(" • ")}
                      </div>
                    )}
                    {(selectedItem.data.attachment_insights.highlights || []).length > 0 && (
                      <div className="bg-background border p-2 space-y-1">
                        {selectedItem.data.attachment_insights.highlights.slice(0, 3).map((line, idx) => (
                          <p key={idx} className="text-[11px] text-muted-foreground">
                            {line}
                          </p>
                        ))}
                      </div>
                    )}
                    {(selectedItem.data.attachment_insights.filename_signals || []).length > 0 && (
                      <div className="text-[11px] text-muted-foreground">
                        Detected from filenames: {selectedItem.data.attachment_insights.filename_signals.join(", ").replaceAll("_", " ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Inline correspondence — expands below inbound */}
          {showCorrespondence && (
            <div className="border p-3">
              <SectionLabel>Full Correspondence</SectionLabel>
              {correspondenceLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : correspondenceMessages.length > 0 ? (
                <div className="mt-2">
                  <Thread messages={correspondenceMessages} maxHeight="h-auto" />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No messages found
                </p>
              )}
            </div>
          )}

          {/* Draft content — editable */}
          {(draftBody || draftSubject || (selectedProposalId && !proposalDetail)) && (
            <div className="border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <SectionLabel>
                  {selectedItem.data.action_type === "SUBMIT_PORTAL" ? "Portal Submission Text" : "Draft Email"}
                  <span className="ml-2 text-[10px] text-muted-foreground font-normal normal-case">edit inline before approving</span>
                </SectionLabel>
                {(editedBody !== (draftBody || "") || editedSubject !== (draftSubject || "") || editedRecipient !== originalRecipient) && (
                  <button
                    className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                    onClick={() => {
                      setEditedBody(draftBody || "");
                      setEditedSubject(draftSubject || "");
                      setEditedRecipient(originalRecipient);
                    }}
                  >
                    <RotateCcw className="h-3 w-3" /> Reset to AI Draft
                  </button>
                )}
              </div>
              {selectedItem.data.action_type?.startsWith("SEND") && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground font-medium shrink-0">To:</span>
                  <input
                    className="flex-1 bg-background border rounded px-2 py-1 text-xs font-[inherit]"
                    value={editedRecipient}
                    onChange={(e) => setEditedRecipient(e.target.value)}
                    placeholder="recipient@agency.gov"
                  />
                </div>
              )}
              {(draftSubject || editedSubject) && (
                <input
                  className="w-full bg-background border rounded px-2 py-1 text-xs font-[inherit]"
                  value={editedSubject}
                  onChange={(e) => setEditedSubject(e.target.value)}
                  placeholder="Subject"
                />
              )}
              <textarea
                className="w-full bg-background border rounded p-2 text-xs font-[inherit] leading-relaxed resize-y"
                rows={12}
                value={editedBody}
                onChange={(e) => setEditedBody(e.target.value)}
                placeholder={draftBody === null ? "(loading draft...)" : ""}
              />
              {/* Prepared + outbound attachments */}
              <div className="border border-green-800/40 rounded p-2 space-y-2">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-green-500" />
                  Outbound Attachments
                </p>
                {/* Prepared attachments from DB (filled PDFs, etc.) */}
                {(() => {
                  const prepared = (selectedItem.data.attachments || []).filter((a: any) => a.direction === 'outbound');
                  if (prepared.length === 0) return null;
                  return (
                    <div className="space-y-1.5">
                      {prepared.map((att: any) => (
                        <div
                          key={att.id}
                          className="flex items-center justify-between border bg-background px-2 py-1.5 text-xs"
                        >
                          <a
                            href={att.download_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 min-w-0 hover:underline"
                          >
                            <Paperclip className="h-3 w-3 flex-shrink-0 text-green-500" />
                            <span className="truncate">{att.filename || `Attachment #${att.id}`}</span>
                            <Badge variant="outline" className="text-[9px] px-1 py-0 text-green-400 border-green-700/50">prepared</Badge>
                          </a>
                          <span className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-muted-foreground">
                              {att.size_bytes ? `${Math.max(1, Math.round(att.size_bytes / 1024))} KB` : "file"}
                            </span>
                            <button
                              type="button"
                              className="text-red-400 hover:text-red-300 p-0.5"
                              title="Delete attachment"
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!confirm(`Delete "${att.filename}"?`)) return;
                                try {
                                  const res = await fetch(`/api/requests/${selectedItem.data.id}/attachments/${att.id}`, { method: 'DELETE' });
                                  if (!res.ok) throw new Error('Delete failed');
                                  mutate();
                                } catch (err) {
                                  alert('Failed to delete attachment');
                                }
                              }}
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {/* Add new attachments */}
                <AttachmentPicker
                  attachments={outboundAttachments}
                  onChange={setOutboundAttachments}
                  disabled={isSubmitting}
                />
              </div>
            </div>
          )}

          {/* Audit trail */}
          {auditData?.actions && auditData.actions.length > 0 && (
            <Collapsible>
              <div className="border p-3">
                <div className="flex items-center justify-between">
                  <SectionLabel>Recent Actions</SectionLabel>
                  <CollapsibleTrigger asChild>
                    <button className="text-[10px] text-primary hover:underline">
                      Show
                    </button>
                  </CollapsibleTrigger>
                </div>
                <CollapsibleContent>
                  <div className="mt-2 space-y-1.5">
                    {auditData.actions.map((a) => (
                      <div key={a.id} className="flex items-start gap-2 text-[10px]">
                        <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                          {formatRelativeTime(a.created_at)}
                        </span>
                        <span className="text-foreground/80 break-words min-w-0">
                          <span className="text-muted-foreground font-mono">{a.event_type.replace(/_/g, " ")}</span>
                          {" — "}
                          {(a.description || "").substring(0, 120)}
                          {a.user_id ? ` (${userNameMap[a.user_id] || `user #${a.user_id}`})` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          )}

          {/* Action buttons */}
          <div className="border-t pt-4 space-y-2">
            {/* Action explanation */}
            <p className="text-[10px] text-muted-foreground">
              {manualPdfEscalation
                ? "Manual fallback: complete the attached PDF form and send it yourself. Dismiss this handoff once you have handled it."
                : getActionExplanation(
                    selectedItem.data.action_type,
                    !!draftBody,
                    selectedItem.data.portal_url,
                    selectedItem.data.effective_agency_email || selectedItem.data.agency_email
                  )}
            </p>
            {isEscalateProposal && !manualPdfEscalation && (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground">
                  Provide guidance and approve. The AI will execute this direction and return with a concrete next proposal.
                </p>
                <Textarea
                  placeholder="Example: Research the correct records custodian for body-cam footage, then draft a targeted request to that agency."
                  value={reviewInstruction}
                  onChange={(e) => setReviewInstruction(e.target.value)}
                  className="text-xs bg-background min-h-[76px]"
                />
              </div>
            )}
            {(() => {
              const gateOptions = selectedItem.data.gate_options as string[] | null;
              const showApprove = (!gateOptions || gateOptions.includes("APPROVE")) && !manualPdfEscalation;
              const showAdjust = !gateOptions || gateOptions.includes("ADJUST");
              const showDismiss = !gateOptions || gateOptions.includes("DISMISS");
              const showRetryResearch = gateOptions?.includes("RETRY_RESEARCH");
              const showAddToInvoicing = gateOptions?.includes("ADD_TO_INVOICING");
              const showWaitForGoodToPay = gateOptions?.includes("WAIT_FOR_GOOD_TO_PAY");
              return (
                <>
                  <div className="flex gap-2">
                    {showRetryResearch && (
                      <Button
                        className="flex-1 bg-amber-700 hover:bg-amber-600 text-white"
                        onClick={handleRetryResearch}
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? (
                          <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3 mr-1.5" />
                        )}
                        Retry Research
                      </Button>
                    )}
                    {showApprove && (
                      <Button
                        className="flex-1 bg-green-700 hover:bg-green-600 text-white"
                        onClick={handleApprove}
                        disabled={!canTakeAction || isSubmitting || (isEscalateProposal && !manualPdfEscalation && !reviewInstruction.trim())}
                      >
                        {isSubmitting ? (
                          <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                        ) : (
                          <Send className="h-3 w-3 mr-1.5" />
                        )}
                        {getApproveLabel(selectedItem.data.action_type)}
                        <span className="ml-2 text-[10px] opacity-60 border border-white/20 px-1">
                          A
                        </span>
                      </Button>
                    )}
                    {showAdjust && (
                      <Button
                        variant="outline"
                        onClick={() => setShowAdjustModal(true)}
                        disabled={isSubmitting}
                      >
                        <Edit className="h-3 w-3 mr-1" /> ADJUST
                      </Button>
                    )}
                  </div>
                  {(showAddToInvoicing || showWaitForGoodToPay) && (
                    <div className="flex gap-2">
                      {showAddToInvoicing && (
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() => handleFeeWorkflowDecision("ADD_TO_INVOICING")}
                          disabled={isSubmitting}
                        >
                          <DollarSign className="h-3 w-3 mr-1" /> {getFeeDecisionLabel("ADD_TO_INVOICING")}
                        </Button>
                      )}
                      {showWaitForGoodToPay && (
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() => handleFeeWorkflowDecision("WAIT_FOR_GOOD_TO_PAY")}
                          disabled={isSubmitting}
                        >
                          <Clock className="h-3 w-3 mr-1" /> {getFeeDecisionLabel("WAIT_FOR_GOOD_TO_PAY")}
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="flex gap-2">
                    {showDismiss && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            className="flex-1"
                            disabled={!canTakeAction || isSubmitting}
                          >
                            <Trash2 className="h-3 w-3 mr-1" /> DISMISS
                            <span className="ml-1 text-[10px] opacity-60 border border-white/20 px-1">
                              D
                            </span>
                            <ChevronDown className="h-3 w-3 ml-1" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {DISMISS_REASONS.map((reason) => (
                            <DropdownMenuItem
                              key={reason}
                              onClick={() => handleDismiss(reason)}
                              className="text-xs"
                            >
                              {reason}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={() => {
                        if (window.confirm("Withdraw this case? This will cancel the request permanently.")) {
                          handleWithdraw();
                        }
                      }}
                      disabled={isSubmitting}
                    >
                      <Ban className="h-3 w-3 mr-1" /> WITHDRAW
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1 text-orange-400 border-orange-700/50 hover:bg-orange-950/20"
                      onClick={handleMarkBugged}
                      disabled={isSubmitting}
                    >
                      <Bug className="h-3 w-3 mr-1" /> BUGGED
                    </Button>
                  </div>
                </>
              );
            })()}
            {selectedCaseAlreadyInPhoneQueue ? (
              <Button
                variant="outline"
                className="w-full text-amber-300/80 border-amber-700/40"
                disabled
              >
                <Phone className="h-3 w-3 mr-1.5" />
                ALREADY IN PHONE QUEUE
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-full text-amber-400 border-amber-700/50 hover:bg-amber-950/20"
                onClick={() => handleAddToPhoneQueue(selectedItem.data.case_id, "clarification_needed")}
                disabled={addingToPhoneQueue || isSubmitting}
              >
                {addingToPhoneQueue ? (
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                ) : (
                  <Phone className="h-3 w-3 mr-1.5" />
                )}
                ADD TO PHONE QUEUE
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Human Review View ──────────────── */}
      {selectedItem?.type === "review" && !bulkMode && (
        <div className="space-y-4">
          {/* Case header */}
          <div className="border-b pb-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-mono">
                    #{selectedItem.data.id}
                  </span>
                  <h2 className="text-sm font-semibold">
                    {selectedItem.data.case_name || "Unnamed Case"}
                  </h2>
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-xs text-muted-foreground">
                    {selectedItem.data.agency_name}
                  </span>
                  {selectedItem.data.user_id && (
                    <Badge variant="outline" className="text-[10px] text-cyan-400 border-cyan-700/50">
                      {userNameMap[selectedItem.data.user_id] || `User #${selectedItem.data.user_id}`}
                    </Badge>
                  )}
                  <Badge
                    variant="outline"
                    className="text-[10px] text-purple-400 border-purple-700/50"
                  >
                    HUMAN REVIEW
                  </Badge>
                  {selectedItem.data.status && (
                    <Badge variant="outline" className="text-[10px]">
                      {selectedItem.data.status.replace(/_/g, " ")}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openCorrespondence(selectedItem.data.id)}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <MessageSquare className="h-3 w-3" /> Thread
                </button>
                <Link
                  href={`/requests/detail-v2?id=${selectedItem.data.id}`}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" /> Case
                </Link>
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeTime(selectedItem.data.updated_at)}
                </span>
              </div>
            </div>
          </div>

          {/* AI Summary — what happened and what to do */}
          <div className="border border-purple-700/30 bg-purple-950/15 p-3 space-y-2">
            <p className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider flex items-center gap-1">
              <Brain className="h-3 w-3" /> AI Summary
            </p>
            <div className="text-xs space-y-1.5">
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0 w-[70px]">Reason:</span>
                <span className="text-foreground/80">
                  {humanizeSubstatus(selectedItem.data.substatus || selectedItem.data.pause_reason || "Needs human review")}
                </span>
              </div>
              {selectedItem.data.research_summary && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">Research:</span>
                  <span className="text-foreground/80 line-clamp-2">
                    {selectedItem.data.research_summary.slice(0, 150)}{selectedItem.data.research_summary.length > 150 ? "..." : ""}
                  </span>
                </div>
              )}
              {selectedItem.data.last_fee_quote_amount != null && (
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0 w-[70px]">Fee:</span>
                  <span className="text-amber-400 font-medium">${Number(selectedItem.data.last_fee_quote_amount).toFixed(2)}</span>
                </div>
              )}
              <div className="flex items-start gap-2">
                <span className="text-muted-foreground shrink-0 w-[70px]">Next step:</span>
                <span className="text-foreground/80">
                  {selectedItem.data.portal_url ? "Review portal status and resolve." :
                   selectedItem.data.last_fee_quote_amount ? "Decide whether to accept, negotiate, or decline the fee." :
                   "Review the case context and decide how to proceed."}
                </span>
              </div>
            </div>
          </div>

          {/* Substatus / reason */}
          {(() => {
            const rawReason = selectedItem.data.substatus || "";
            const summary = selectedItem.data.research_summary || "";
            const hasRecoveredChannels =
              /Contact channels discovered|New contact channels found|Phone target:/i.test(summary);
            const displayReason =
              /agency_research_failed/i.test(rawReason) && hasRecoveredChannels
                ? "agency_research_complete"
                : rawReason;
            if (!displayReason) return null;
            return (
            <div className="border border-purple-700/50 bg-purple-950/20 p-3">
              <SectionLabel>Review Reason</SectionLabel>
              <p className="text-xs text-purple-300">
                {humanizeSubstatus(displayReason)}
              </p>
            </div>
            );
          })()}

          {categorizeReview(selectedItem.data) !== "phone" && selectedItem.data.research_summary && (
            <div className="border border-sky-700/50 bg-sky-950/20 p-3">
              <SectionLabel>Research Findings</SectionLabel>
              <p className="text-xs text-sky-200 whitespace-pre-wrap">
                {selectedItem.data.research_summary}
              </p>
            </div>
          )}

          {/* Fee info */}
          {selectedItem.data.last_fee_quote_amount != null && (
            <div className="border border-yellow-700/50 bg-yellow-950/20 p-3">
              <SectionLabel>Fee Quote</SectionLabel>
              <p className="text-sm font-semibold text-yellow-300">
                ${Number(selectedItem.data.last_fee_quote_amount).toFixed(2)}
              </p>
            </div>
          )}

          {/* Portal info */}
          {categorizeReview(selectedItem.data) !== "phone" &&
            (selectedItem.data.portal_url || selectedItem.data.last_portal_task_url) && (
            <div className="border p-3">
              <SectionLabel>Portal</SectionLabel>
              <div className="flex items-center gap-2 flex-wrap">
                {selectedItem.data.portal_url && (
                  <a
                    href={selectedItem.data.portal_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" /> Open Portal
                  </a>
                )}
                {selectedItem.data.last_portal_task_url && (
                  <a
                    href={selectedItem.data.last_portal_task_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-orange-400 hover:underline flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" /> Skyvern Run
                  </a>
                )}
                {selectedItem.data.last_portal_status && (
                  <Badge variant="outline" className="text-[10px] text-red-400 border-red-700/50">
                    {selectedItem.data.last_portal_status}
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Inbound — full text */}
          {selectedItem.data.last_inbound_preview && (
            <div className="border p-3">
              <div className="flex items-center justify-between mb-1.5">
                <SectionLabel>Last Inbound</SectionLabel>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => openCorrespondence(selectedItem.data.id)}
                >
                  <MessageSquare className="h-3 w-3 mr-1" />
                  {showCorrespondence ? "Hide Correspondence" : "See Full Correspondence"}
                </Button>
              </div>
              {(() => {
                const { body: reviewClean, quotedThread: reviewQuoted } = cleanEmailBody(selectedItem.data.last_inbound_preview || "");
                return (
                  <div className="bg-background border p-2">
                    <LinkifiedText
                      text={reviewClean}
                      className="text-xs whitespace-pre-wrap font-[inherit] text-foreground/80"
                    />
                    {reviewQuoted && (
                      <details className="mt-2 border-t border-border/50 pt-2">
                        <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                          Show full thread
                        </summary>
                        <div className="mt-1.5 pl-2 border-l-2 border-muted">
                          <LinkifiedText
                            text={reviewQuoted}
                            className="text-xs whitespace-pre-wrap font-[inherit] text-muted-foreground/60"
                          />
                        </div>
                      </details>
                    )}
                  </div>
                );
              })()}
              {selectedItem.data.inbound_count > 0 && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  {selectedItem.data.inbound_count} inbound message(s) total
                </p>
              )}
            </div>
          )}

          {/* Inline correspondence — expands below inbound */}
          {showCorrespondence && (
            <div className="border p-3">
              <SectionLabel>Full Correspondence</SectionLabel>
              {correspondenceLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : correspondenceMessages.length > 0 ? (
                <div className="mt-2">
                  <Thread messages={correspondenceMessages} maxHeight="h-auto" />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No messages found
                </p>
              )}
            </div>
          )}

          {/* Inline resolution actions */}
          {(() => {
            const category = categorizeReview(selectedItem.data);
            return (
              <div className="border-t pt-4 space-y-3">
                <SectionLabel>Resolve</SectionLabel>

                {/* Context-specific primary actions */}
                {category === "fee" && (
                  <div className="flex gap-2">
                    <Button
                      className="flex-1 bg-green-700 hover:bg-green-600 text-white"
                      onClick={() => handleResolveReview("accept_fee")}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <CheckCircle className="h-3 w-3 mr-1.5" />}
                      ACCEPT FEE
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => handleResolveReview("negotiate_fee")}
                      disabled={isSubmitting}
                    >
                      NEGOTIATE
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleResolveReview("decline_fee")}
                      disabled={isSubmitting}
                    >
                      DECLINE
                    </Button>
                  </div>
                )}

                {category === "portal" && (
                  <div className="flex gap-2">
                    <Button
                      className="flex-1 bg-blue-700 hover:bg-blue-600 text-white"
                      onClick={() => handleResolveReview("retry_portal")}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1.5" />}
                      RETRY PORTAL
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => handleResolveReview("send_via_email")}
                      disabled={isSubmitting}
                    >
                      <Mail className="h-3 w-3 mr-1" /> EMAIL INSTEAD
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleResolveReview("mark_sent")}
                      disabled={isSubmitting}
                    >
                      MARK SENT
                    </Button>
                  </div>
                )}

                {category === "denial" && (
                  <div className="flex gap-2">
                    <Button
                      className="flex-1 bg-purple-700 hover:bg-purple-600 text-white"
                      onClick={() => handleResolveReview("appeal")}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <FileText className="h-3 w-3 mr-1.5" />}
                      SEND APPEAL
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => handleResolveReview("narrow_scope")}
                      disabled={isSubmitting}
                    >
                      NARROW & RETRY
                    </Button>
                  </div>
                )}

                {category === "general" && (
                  <div className="flex gap-2">
                    <Button
                      className="flex-1 bg-purple-700 hover:bg-purple-600 text-white"
                      onClick={() => handleResolveReview("reprocess")}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1.5" />}
                      RE-PROCESS
                    </Button>
                  </div>
                )}

                {category === "phone" && (
                  <div className="space-y-2">
                    <div className="border p-2 bg-amber-950/20 border-amber-700/40">
                      <p className="text-xs text-amber-300 font-medium">Phone Call Proposal</p>
                      <div className="mt-1 text-xs text-foreground/90 space-y-1">
                        <p>
                          <span className="text-muted-foreground">Who:</span>{" "}
                          {selectedItem.data.phone_call_plan?.agency_name || deriveDisplayAgencyName(selectedItem.data)}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Phone:</span>{" "}
                          {selectedItem.data.phone_call_plan?.agency_phone || "Not found yet"}
                        </p>
                        {selectedItem.data.phone_call_plan?.reason && (
                          <p>
                            <span className="text-muted-foreground">Why call:</span>{" "}
                            {selectedItem.data.phone_call_plan.reason}
                          </p>
                        )}
                        {selectedItem.data.phone_call_plan?.agency_email && (
                          <p>
                            <span className="text-muted-foreground">Known email:</span>{" "}
                            {selectedItem.data.phone_call_plan.agency_email}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="flex-1 bg-amber-700 hover:bg-amber-600 text-white"
                        onClick={() => handleMakePhoneCallFromQueue(selectedItem.data.id)}
                        disabled={isSubmitting || !hasCallablePhone(selectedItem.data.phone_call_plan?.agency_phone)}
                      >
                        <Phone className="h-3 w-3 mr-1.5" />
                        MAKE PHONE CALL
                      </Button>
                      {selectedCaseAlreadyInPhoneQueue ? (
                        <Button
                          variant="outline"
                          className="flex-1 text-amber-300/80 border-amber-700/40"
                          disabled
                        >
                          <Phone className="h-3 w-3 mr-1.5" />
                          ALREADY IN PHONE QUEUE
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          className="flex-1"
                          onClick={() => handleAddToPhoneQueue(selectedItem.data.id, "research_handoff")}
                          disabled={addingToPhoneQueue || isSubmitting || !hasCallablePhone(selectedItem.data.phone_call_plan?.agency_phone)}
                        >
                          {addingToPhoneQueue ? (
                            <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                          ) : (
                            <Phone className="h-3 w-3 mr-1.5" />
                          )}
                          QUEUE PHONE CALL
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {/* Custom instruction */}
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Custom instruction (optional)..."
                    ref={reviewInstructionRef}
                    value={reviewInstruction}
                    onChange={(e) => setReviewInstruction(e.target.value)}
                    onInput={(e) => setReviewInstruction((e.target as HTMLTextAreaElement).value)}
                    className="text-xs bg-background min-h-[60px] flex-1"
                  />
                  <Button
                    variant="outline"
                    className="self-end"
                    onClick={() => handleResolveReview("custom", getReviewInstructionText().trim())}
                    disabled={isSubmitting || !getReviewInstructionText().trim()}
                  >
                    <Send className="h-3 w-3 mr-1" /> SEND
                  </Button>
                </div>

                {/* Secondary actions */}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => handleResolveReview("put_on_hold")}
                    disabled={isSubmitting}
                  >
                    HOLD
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      const item = selectedItem;
                      setShowDestructiveConfirm({
                        title: `Close case #${item.data.id}?`,
                        description: "This marks the case as completed/closed. You have 5 seconds to undo after confirming.",
                        onConfirm: () => {
                          setShowDestructiveConfirm(null);
                          scheduleUndoableAction(
                            `Closed: case #${item.data.id}`,
                            item,
                            async () => {
                              const res = await fetch(`/api/requests/${item.data.id}/resolve-review`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "close" }),
                              });
                              const data = await res.json();
                              if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);
                            },
                          );
                        },
                      });
                    }}
                    disabled={isSubmitting}
                  >
                    CLOSE
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      if (window.confirm("Withdraw this case? This will cancel the request permanently.")) {
                        handleWithdraw();
                      }
                    }}
                    disabled={isSubmitting}
                  >
                    <Ban className="h-3 w-3 mr-1" /> WITHDRAW
                  </Button>
                  <Button
                    variant="outline"
                    className="text-orange-400 border-orange-700/50 hover:bg-orange-950/20"
                    onClick={handleMarkBugged}
                    disabled={isSubmitting}
                  >
                    <Bug className="h-3 w-3 mr-1" /> BUGGED
                  </Button>
                  <Link href={`/requests/detail-v2?id=${selectedItem.data.id}`}>
                    <Button variant="ghost" className="text-xs text-muted-foreground">
                      <ExternalLink className="h-3 w-3 mr-1" /> Full Case
                    </Button>
                  </Link>
                </div>

                {/* Add to phone queue (except dedicated phone category) */}
                {category !== "phone" && (
                  selectedCaseAlreadyInPhoneQueue ? (
                    <Button
                      variant="outline"
                      className="w-full text-amber-300/80 border-amber-700/40"
                      disabled
                    >
                      <Phone className="h-3 w-3 mr-1.5" />
                      ALREADY IN PHONE QUEUE
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      className="w-full text-amber-400 border-amber-700/50 hover:bg-amber-950/20"
                      onClick={() => handleAddToPhoneQueue(selectedItem.data.id, "clarification_needed")}
                      disabled={addingToPhoneQueue || isSubmitting}
                    >
                      {addingToPhoneQueue ? (
                        <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                      ) : (
                        <Phone className="h-3 w-3 mr-1.5" />
                      )}
                      ADD TO PHONE QUEUE
                    </Button>
                  )
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Unmatched inbound accessible via the Inbound tab (click "Unmatched" stat) */}

      </>)}

      {/* ── Inbound Tab ────────────────────── */}
      {activeTab === "inbound" && (() => {
        const filteredInbound = (inboundData?.inbound || []).filter((msg) => {
          if (inboundFilter === "unmatched") return !msg.case_id;
          if (inboundFilter === "matched") return !!msg.case_id;
          return true;
        });
        const unmatchedCount = (inboundData?.inbound || []).filter(m => !m.case_id).length;

        return (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {(["all", "unmatched", "matched"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setInboundFilter(f)}
                    className={cn(
                      "text-[10px] uppercase tracking-widest px-2 py-1 border-b-2 -mb-px transition-colors",
                      inboundFilter === f
                        ? "text-foreground border-foreground"
                        : "text-muted-foreground border-transparent hover:text-foreground"
                    )}
                  >
                    {f}
                    {f === "unmatched" && unmatchedCount > 0 && (
                      <Badge variant="outline" className="h-4 px-1 text-[10px] leading-none ml-1 text-amber-400 border-amber-700/50">
                        {unmatchedCount}
                      </Badge>
                    )}
                  </button>
                ))}
              </div>
              <Button variant="ghost" size="sm" onClick={() => mutateInbound()} title="Refresh">
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>
            {!inboundData ? (
              <div className="flex items-center justify-center h-40">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filteredInbound.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-sm text-muted-foreground">
                No {inboundFilter === "all" ? "" : inboundFilter + " "}messages found.
              </div>
            ) : (
              <div className="space-y-1">
                {filteredInbound.map((msg) => {
                  const isExpanded = expandedMessageId === msg.id;
                  const isMatching = matchingMessageId === msg.id;
                  const isUnmatched = !msg.case_id;

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        "border transition-colors",
                        isUnmatched && "border-amber-700/30 bg-amber-950/5",
                        isExpanded && "ring-1 ring-foreground/20"
                      )}
                    >
                      {/* Row header — clickable to expand */}
                      <button
                        className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-muted/20"
                        onClick={() => setExpandedMessageId(isExpanded ? null : msg.id)}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            {msg.case_id ? (
                              <Link
                                href={`/requests/detail-v2?id=${msg.case_id}`}
                                className="text-[10px] text-blue-400 hover:underline flex items-center gap-0.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                #{msg.case_id} <ArrowUpRight className="h-2.5 w-2.5" />
                              </Link>
                            ) : (
                              <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-700/50">
                                UNMATCHED
                              </Badge>
                            )}
                            {msg.intent && (
                              <Badge variant="outline" className="text-[10px]">
                                {msg.intent.replace(/_/g, " ")}
                              </Badge>
                            )}
                            {msg.sentiment && msg.sentiment !== "neutral" && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "text-[10px]",
                                  msg.sentiment === "HOSTILE" && "text-red-400 border-red-700/50",
                                  msg.sentiment === "FRUSTRATED" && "text-orange-400 border-orange-700/50",
                                  msg.sentiment === "COOPERATIVE" && "text-green-400 border-green-700/50"
                                )}
                              >
                                {msg.sentiment}
                              </Badge>
                            )}
                            <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">
                              {formatRelativeTime(msg.received_at)}
                            </span>
                          </div>
                          <p className="text-xs truncate">
                            <span className="text-muted-foreground">{msg.from_email}</span>
                            {" — "}
                            {msg.subject || "(no subject)"}
                          </p>
                        </div>
                        <ChevronRight className={cn(
                          "h-3 w-3 text-muted-foreground transition-transform flex-shrink-0",
                          isExpanded && "rotate-90"
                        )} />
                      </button>

                      {/* Expanded content */}
                      {isExpanded && (
                        <div className="border-t px-3 py-3 space-y-3">
                          {/* AI Summary */}
                          {msg.key_points && msg.key_points.length > 0 && (
                            <div className="border-l-2 border-muted pl-2">
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">AI Summary</p>
                              {msg.key_points.map((point, i) => (
                                <p key={i} className="text-xs text-foreground/80">- {point}</p>
                              ))}
                            </div>
                          )}

                          {/* Case info if matched */}
                          {msg.case_id && msg.case_name && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground">Linked to:</span>
                              <Link
                                href={`/requests/detail-v2?id=${msg.case_id}`}
                                className="text-xs text-blue-400 hover:underline"
                              >
                                #{msg.case_id} — {msg.case_name} ({msg.agency_name})
                              </Link>
                            </div>
                          )}

                          {/* Email body */}
                          {(() => {
                            const { body: cleanBody, quotedThread } = cleanEmailBody(msg.body_text || "");
                            return (
                              <div className="bg-background border p-3 max-h-64 overflow-auto">
                                <LinkifiedText
                                  text={cleanBody || "(no body text)"}
                                  className="text-xs whitespace-pre-wrap font-[inherit] text-foreground/80"
                                />
                                {quotedThread && (
                                  <details className="mt-2 border-t border-border/50 pt-2">
                                    <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                                      Show full thread
                                    </summary>
                                    <div className="mt-1.5 pl-2 border-l-2 border-muted">
                                      <LinkifiedText
                                        text={quotedThread}
                                        className="text-xs whitespace-pre-wrap font-[inherit] text-muted-foreground/60"
                                      />
                                    </div>
                                  </details>
                                )}
                              </div>
                            );
                          })()}

                          {/* Match to case — only for unmatched */}
                          {isUnmatched && (
                            <div className="border border-amber-700/30 bg-amber-950/10 p-3 space-y-2">
                              <p className="text-[10px] text-amber-400 uppercase tracking-wider font-semibold">
                                Link to Case
                              </p>

                              {/* Suggested matches */}
                              {msg.suggested_cases && msg.suggested_cases.length > 0 && (
                                <div className="space-y-1">
                                  <p className="text-[10px] text-muted-foreground">Suggested (same email domain):</p>
                                  {msg.suggested_cases.map((sc) => (
                                    <button
                                      key={sc.id}
                                      className="w-full text-left px-2 py-1.5 border hover:bg-muted/30 flex items-center justify-between group"
                                      onClick={() => handleMatchToCase(msg.id, sc.id)}
                                    >
                                      <span className="text-xs">
                                        <span className="text-muted-foreground">#{sc.id}</span>{" "}
                                        {sc.case_name} — <span className="text-muted-foreground">{sc.agency_name}</span>
                                      </span>
                                      <span className="text-[10px] text-green-400 opacity-0 group-hover:opacity-100">
                                        Link
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              )}

                              {/* Manual case ID */}
                              <div className="flex items-center gap-2">
                                <Input
                                  placeholder="Case ID..."
                                  value={isMatching ? manualCaseId : ""}
                                  onChange={(e) => {
                                    setMatchingMessageId(msg.id);
                                    setManualCaseId(e.target.value);
                                  }}
                                  onFocus={() => setMatchingMessageId(msg.id)}
                                  className="h-7 text-xs w-28 bg-background"
                                />
                                <Button
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={!isMatching || !manualCaseId.trim()}
                                  onClick={() => {
                                    const id = parseInt(manualCaseId);
                                    if (id) handleMatchToCase(msg.id, id);
                                  }}
                                >
                                  Link
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Phone Calls Tab ────────────────── */}
      {activeTab === "calls" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                Phone Call Queue
              </span>
              {phoneData?.stats && (
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-700/50">
                    {phoneData.stats.pending} pending
                  </Badge>
                  <Badge variant="outline" className="text-[10px] text-blue-400 border-blue-700/50">
                    {phoneData.stats.claimed} claimed
                  </Badge>
                  <Badge variant="outline" className="text-[10px] text-green-400 border-green-700/50">
                    {phoneData.stats.completed} done
                  </Badge>
                </div>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => mutatePhone()} title="Refresh">
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          {!phoneData ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : phoneData.tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-sm text-muted-foreground">
              No pending phone calls.
            </div>
          ) : (
            <div className="space-y-2">
              {phoneData.tasks.map((task) => {
                const isExpanded = expandedPhoneCallId === task.id;
                const isTaskSubmitting = phoneCallSubmitting === task.id;
                const briefing = (() => {
                  if (!task.ai_briefing) return null;
                  if (typeof task.ai_briefing === "string") {
                    try { return JSON.parse(task.ai_briefing); } catch { return { case_summary: task.ai_briefing }; }
                  }
                  return task.ai_briefing as Record<string, unknown>;
                })();
                const REASON_LABELS: Record<string, string> = {
                  no_email_response: "No email response",
                  manual_add: "Added manually",
                  clarification_needed: "Needs clarification",
                  details_needed: "Details needed",
                  complex_inquiry: "Complex inquiry",
                  portal_failed: "Portal failed",
                  clarification_difficult: "Clarification by phone",
                };
                const REASON_PURPOSES: Record<string, string> = {
                  no_email_response: "Confirm status and unblock the request when email has stalled.",
                  manual_add: "Manual follow-up requested by operator.",
                  clarification_needed: "Get missing details needed to proceed with records processing.",
                  details_needed: "Collect additional case/request details by phone.",
                  complex_inquiry: "Handle an issue better resolved live than over email.",
                  portal_failed: "Recover from portal submission failure and confirm next intake path.",
                  clarification_difficult: "Clarify agency requirements that were unclear in writing.",
                };
                const callPurpose =
                  (task.notes && String(task.notes).trim()) ||
                  REASON_PURPOSES[task.reason || ""] ||
                  "Follow up on this request by phone.";

                return (
                  <div
                    key={task.id}
                    className={cn(
                      "border transition-colors",
                      task.call_outcome && "border-amber-700/20 bg-amber-950/5",
                      isExpanded && "ring-1 ring-foreground/20"
                    )}
                  >
                    {/* Row header — clickable to expand */}
                    <button
                      className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-muted/20"
                      onClick={() => {
                        setExpandedPhoneCallId(isExpanded ? null : task.id);
                        if (!isExpanded) {
                          setCheckedPoints(new Set());
                          setCallNotes("");
                          setCallOutcome(null);
                          setNextStepSuggestion(null);
                        }
                      }}
                    >
                      <Phone className={cn(
                        "h-4 w-4 flex-shrink-0",
                        task.call_outcome ? "text-muted-foreground" : "text-amber-400"
                      )} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium">
                            {task.agency_name || `Case #${task.case_id}`}
                          </span>
                          {task.agency_state && (
                            <span className="text-[10px] text-muted-foreground">{task.agency_state}</span>
                          )}
                          {task.call_outcome ? (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              {task.call_outcome.replace(/_/g, " ")} — retry
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-700/50">
                              PENDING
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          {task.agency_phone && (
                            <span className="text-xs font-mono text-foreground">{task.agency_phone}</span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {REASON_LABELS[task.reason || ""] || task.reason || ""}
                          </span>
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                          Call purpose: {callPurpose}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {task.created_at && (
                          <span className="text-[10px] text-muted-foreground">
                            {formatRelativeTime(task.created_at)}
                          </span>
                        )}
                        <ChevronRight className={cn(
                          "h-3 w-3 text-muted-foreground transition-transform",
                          isExpanded && "rotate-90"
                        )} />
                      </div>
                    </button>

                    {/* Expanded detail card */}
                    {isExpanded && (
                      <div className="border-t px-3 py-3 space-y-3">
                        {/* Phone number — prominent */}
                        <div className="border p-3 bg-background">
                          <SectionLabel>Phone Number</SectionLabel>
                          {task.agency_phone ? (
                            <a
                              href={`tel:${task.agency_phone}`}
                              className="text-lg font-mono font-semibold text-foreground hover:text-blue-400 transition-colors"
                            >
                              {task.agency_phone}
                            </a>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-sm text-muted-foreground italic">No phone number on file</p>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs text-amber-400 border-amber-700/50 hover:bg-amber-950/20"
                                onClick={() => handleFindPhoneNumber(task.id)}
                                disabled={isTaskSubmitting}
                              >
                                {isTaskSubmitting ? (
                                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3 w-3 mr-1.5" />
                                )}
                                {isTaskSubmitting ? "SEARCHING..." : "FIND PHONE NUMBER"}
                              </Button>
                            </div>
                          )}
                          {/* Phone options if available */}
                          {task.phone_options && (
                            <div className="mt-2 space-y-1">
                              {Array.isArray(task.phone_options.candidates) && task.phone_options.candidates.length > 0 && (
                                <div className="space-y-1">
                                  {task.phone_options.candidates.map((candidate, idx) => (
                                    <p key={`${candidate.phone}-${idx}`} className="text-[10px] text-muted-foreground">
                                      {candidate.is_new ? "New" : "Alt"} {candidate.kind === "fax" ? "fax" : "phone"}:
                                      {" "}
                                      <span className="font-mono">{candidate.phone}</span>
                                      {candidate.agency_name ? ` • ${candidate.agency_name}` : ""}
                                      {candidate.contact_name ? ` • ${candidate.contact_name}` : ""}
                                      {candidate.source ? ` • ${candidate.source}` : ""}
                                    </p>
                                  ))}
                                </div>
                              )}
                              {(!Array.isArray(task.phone_options.candidates) || task.phone_options.candidates.length === 0) && task.phone_options.notion?.phone && task.phone_options.notion.phone !== task.agency_phone && (
                                <p className="text-[10px] text-muted-foreground">
                                  Notion: <span className="font-mono">{task.phone_options.notion.phone}</span>
                                </p>
                              )}
                              {(!Array.isArray(task.phone_options.candidates) || task.phone_options.candidates.length === 0) && task.phone_options.web_search?.phone && task.phone_options.web_search.phone !== task.agency_phone && (
                                <p className="text-[10px] text-muted-foreground">
                                  Web: <span className="font-mono">{task.phone_options.web_search.phone}</span>
                                  {task.phone_options.web_search.confidence && (
                                    <span className="ml-1 text-muted-foreground">({task.phone_options.web_search.confidence})</span>
                                  )}
                                </p>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Case details */}
                        <div className="border p-3 bg-background">
                          <SectionLabel>Case Details</SectionLabel>
                          {(() => {
                            const requestedRecords = Array.isArray(task.requested_records)
                              ? task.requested_records
                              : typeof task.requested_records === "string"
                                ? task.requested_records.split(/\n|,/).map((v) => v.trim()).filter(Boolean)
                                : [];
                            return (
                          <div className="space-y-1 text-xs">
                            <div className="flex items-center gap-2">
                              <Link
                                href={`/requests/detail-v2?id=${task.case_id}`}
                                className="text-blue-400 hover:underline flex items-center gap-1"
                              >
                                #{task.case_id} {task.case_name || ""} <ArrowUpRight className="h-2.5 w-2.5" />
                              </Link>
                            </div>
                            {task.subject_name && (
                              <p><span className="text-muted-foreground">Subject:</span> {task.subject_name}</p>
                            )}
                            {task.agency_email && (
                              <p><span className="text-muted-foreground">Email:</span> {task.agency_email}</p>
                            )}
                            {task.days_since_sent != null && (
                              <p><span className="text-muted-foreground">Days since sent:</span> {task.days_since_sent}</p>
                            )}
                            {task.case_status && (
                              <p><span className="text-muted-foreground">Case status:</span> {task.case_status.replace(/_/g, " ")}</p>
                            )}
                            {task.case_substatus && (
                              <p><span className="text-muted-foreground">Case substatus:</span> {humanizeSubstatus(task.case_substatus)}</p>
                            )}
                            {task.case_pause_reason && (
                              <p><span className="text-muted-foreground">Pause reason:</span> {task.case_pause_reason.replace(/_/g, " ")}</p>
                            )}
                            {requestedRecords.length > 0 && (
                              <div>
                                <p className="text-muted-foreground">Requested records:</p>
                                <div className="pl-2 space-y-0.5">
                                  {requestedRecords.slice(0, 5).map((record, idx) => (
                                    <p key={idx}>- {record}</p>
                                  ))}
                                  {requestedRecords.length > 5 && (
                                    <p className="text-muted-foreground">+{requestedRecords.length - 5} more</p>
                                  )}
                                </div>
                              </div>
                            )}
                            {task.additional_details && !isRawImportDump(task.additional_details) && (
                              <p><span className="text-muted-foreground">Additional details:</span> {task.additional_details}</p>
                            )}
                            {task.notes && (
                              <p><span className="text-muted-foreground">Notes:</span> {task.notes}</p>
                            )}
                            {callPurpose && (
                              <p><span className="text-muted-foreground">Call purpose:</span> {callPurpose}</p>
                            )}
                          </div>
                            );
                          })()}
                        </div>

                        {(task.last_inbound_subject || task.last_inbound_preview) && (
                          <div className="border p-3 bg-background">
                            <SectionLabel>Latest Inbound Context</SectionLabel>
                            {task.last_inbound_subject && (
                              <p className="text-xs mb-1">
                                <span className="text-muted-foreground">Subj:</span> {task.last_inbound_subject}
                              </p>
                            )}
                            {task.last_inbound_from_email && (
                              <p className="text-xs mb-1">
                                <span className="text-muted-foreground">From:</span> {task.last_inbound_from_email}
                              </p>
                            )}
                            {task.last_inbound_preview && (() => {
                              const { body: phoneClean, quotedThread: phoneQuoted } = cleanEmailBody(task.last_inbound_preview);
                              return (
                                <div className="border p-2">
                                  <LinkifiedText
                                    text={phoneClean}
                                    className="text-xs whitespace-pre-wrap text-foreground/80"
                                  />
                                  {phoneQuoted && (
                                    <details className="mt-2 border-t border-border/50 pt-2">
                                      <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                                        Show full thread
                                      </summary>
                                      <div className="mt-1.5 pl-2 border-l-2 border-muted">
                                        <LinkifiedText
                                          text={phoneQuoted}
                                          className="text-xs whitespace-pre-wrap text-muted-foreground/60"
                                        />
                                      </div>
                                    </details>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}

                        {/* AI Briefing — parsed nicely */}
                        {briefing && (
                          <div className="border p-3 bg-background">
                            <SectionLabel>AI Call Briefing</SectionLabel>
                            <div className="space-y-2 text-xs">
                              {typeof briefing === "object" && "case_summary" in briefing && (
                                <p className="text-foreground/80">{String(briefing.case_summary)}</p>
                              )}
                              {typeof briefing === "object" && "call_justification" in briefing && (
                                <div>
                                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Why call</p>
                                  <p className="text-foreground/80">{String(briefing.call_justification)}</p>
                                </div>
                              )}
                              {typeof briefing === "object" && "key_details" in briefing && briefing.key_details && (
                                <div>
                                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Key details</p>
                                  {(() => {
                                    const details = briefing.key_details as Record<string, unknown>;
                                    const dates = (details.dates || {}) as Record<string, unknown>;
                                    const records = (details.records_requested || []) as string[];
                                    const responses = (details.previous_responses || []) as string[];
                                    const daysWaiting = dates.days_waiting != null ? String(dates.days_waiting) : null;
                                    const fmtBriefingDate = (v: unknown): string => {
                                      if (!v) return "";
                                      const s = String(v);
                                      // If it looks like an ISO or parseable date, format it nicely
                                      const d = new Date(s);
                                      if (!isNaN(d.getTime()) && /\d{4}/.test(s)) return formatDate(s);
                                      return s;
                                    };
                                    const requestSent = dates.request_sent ? fmtBriefingDate(dates.request_sent) : null;
                                    // Render any other date fields (e.g. statutory_deadline, response_due)
                                    const extraDateEntries = Object.entries(dates).filter(
                                      ([k]) => !["days_waiting", "request_sent"].includes(k)
                                    );
                                    return (
                                      <div className="space-y-1 text-foreground/80">
                                        {daysWaiting && (
                                          <p>Waiting: {daysWaiting} days</p>
                                        )}
                                        {requestSent && (
                                          <p>Request sent: {requestSent}</p>
                                        )}
                                        {extraDateEntries.map(([key, val]) => (
                                          <p key={key}>
                                            {key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}: {fmtBriefingDate(val)}
                                          </p>
                                        ))}
                                        {records.length > 0 && (
                                          <p>Records: {records.join(", ")}</p>
                                        )}
                                        {responses.length > 0 && (
                                          <div>
                                            <p className="text-muted-foreground">Previous responses:</p>
                                            {responses.map((r, i) => <p key={i} className="pl-2">- {r}</p>)}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })()}
                                </div>
                              )}
                              {/* Fallback for plain string briefing */}
                              {typeof briefing === "object" && !("case_summary" in briefing) && !("talking_points" in briefing) && (
                                <p className="text-foreground/80 whitespace-pre-wrap">{JSON.stringify(briefing, null, 2)}</p>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Talking Points Checklist */}
                        {typeof briefing === "object" && "talking_points" in briefing && Array.isArray(briefing.talking_points) && (briefing.talking_points as string[]).length > 0 && (
                          <div className="border p-3 bg-background">
                            <SectionLabel>Talking Points</SectionLabel>
                            <div className="space-y-1.5 mt-1">
                              {(briefing.talking_points as string[]).map((point, i) => (
                                <label
                                  key={i}
                                  className={cn(
                                    "flex items-start gap-2 cursor-pointer group text-xs",
                                    checkedPoints.has(i) && "opacity-60"
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checkedPoints.has(i)}
                                    onChange={() => {
                                      setCheckedPoints((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(i)) next.delete(i);
                                        else next.add(i);
                                        return next;
                                      });
                                    }}
                                    className="mt-0.5 rounded border-muted-foreground/50"
                                  />
                                  <span className={cn(
                                    "text-foreground/80",
                                    checkedPoints.has(i) && "line-through"
                                  )}>
                                    {point}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Correspondence button */}
                        <Button
                          variant="ghost"
                          className="w-full text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => openCorrespondence(task.case_id)}
                        >
                          <MessageSquare className="h-3 w-3 mr-1.5" />
                          View Full Correspondence
                        </Button>

                        {/* Call Completion Form */}
                        <div className="border-t pt-3 space-y-3">
                          <SectionLabel>Call Result</SectionLabel>

                          {/* Outcome buttons */}
                          <div className="grid grid-cols-3 gap-1.5">
                            {[
                              { outcome: "connected", label: "Spoke with someone", color: "text-green-400 border-green-700/50" },
                              { outcome: "resolved", label: "Issue resolved", color: "text-emerald-400 border-emerald-700/50" },
                              { outcome: "transferred", label: "Transferred", color: "text-blue-400 border-blue-700/50" },
                              { outcome: "voicemail", label: "Left voicemail", color: "text-amber-400 border-amber-700/50" },
                              { outcome: "no_answer", label: "No answer", color: "text-orange-400 border-orange-700/50" },
                              { outcome: "wrong_number", label: "Wrong number", color: "text-red-400 border-red-700/50" },
                            ].map((opt) => (
                              <button
                                key={opt.outcome}
                                onClick={() => setCallOutcome(callOutcome === opt.outcome ? null : opt.outcome)}
                                className={cn(
                                  "border px-2 py-1.5 text-[10px] uppercase tracking-wider transition-colors",
                                  callOutcome === opt.outcome
                                    ? `${opt.color} bg-background ring-1 ring-current font-semibold`
                                    : "text-muted-foreground border-muted hover:text-foreground"
                                )}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>

                          {/* Notes — shown when outcome is selected */}
                          {callOutcome && (
                            <div className="space-y-2">
                              {(callOutcome === "connected" || callOutcome === "resolved" || callOutcome === "transferred") && (
                                <Textarea
                                  placeholder="What was discussed? What did you agree on? Any next steps mentioned..."
                                  value={callNotes}
                                  onChange={(e) => setCallNotes(e.target.value)}
                                  className="text-xs bg-background min-h-[80px]"
                                />
                              )}
                              {(callOutcome === "voicemail" || callOutcome === "no_answer") && (
                                <p className="text-[10px] text-muted-foreground">
                                  Call will move to the bottom of the queue for a retry later.
                                </p>
                              )}
                              {callOutcome === "wrong_number" && (
                                <p className="text-[10px] text-muted-foreground">
                                  Phone number will be cleared. You can search for the correct number after.
                                </p>
                              )}
                              <Button
                                className={cn(
                                  "w-full text-white",
                                  (callOutcome === "voicemail" || callOutcome === "no_answer")
                                    ? "bg-amber-700 hover:bg-amber-600"
                                    : "bg-green-700 hover:bg-green-600"
                                )}
                                onClick={() => handleCompletePhoneCall(task.id, callOutcome)}
                                disabled={isTaskSubmitting || ((callOutcome === "connected" || callOutcome === "resolved") && !callNotes.trim())}
                              >
                                {isTaskSubmitting ? (
                                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                                ) : (callOutcome === "voicemail" || callOutcome === "no_answer") ? (
                                  <Phone className="h-3 w-3 mr-1.5" />
                                ) : (
                                  <CheckCircle className="h-3 w-3 mr-1.5" />
                                )}
                                {(callOutcome === "voicemail" || callOutcome === "no_answer")
                                  ? "MARK & RETRY LATER"
                                  : "SUBMIT CALL RESULT"}
                              </Button>
                            </div>
                          )}

                          {/* AI Next Step Suggestion */}
                          {nextStepSuggestion && (
                            <div className="border border-blue-700/50 bg-blue-950/20 p-3 space-y-2">
                              <SectionLabel>AI Suggested Next Step</SectionLabel>
                              <p className="text-xs font-medium text-blue-300">
                                {nextStepSuggestion.next_action.replace(/_/g, " ")}
                              </p>
                              <p className="text-xs text-foreground/70">{nextStepSuggestion.explanation}</p>
                              {nextStepSuggestion.draft_notes && (
                                <p className="text-xs text-foreground/60 italic border-l-2 border-blue-700/50 pl-2">
                                  {nextStepSuggestion.draft_notes}
                                </p>
                              )}
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  className="flex-1 bg-blue-700 hover:bg-blue-600 text-white text-xs"
                                  onClick={() => {
                                    showToast("Next step accepted — processing...");
                                    setNextStepSuggestion(null);
                                  }}
                                >
                                  ACCEPT
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="flex-1 text-xs"
                                  onClick={() => setNextStepSuggestion(null)}
                                >
                                  DISMISS
                                </Button>
                              </div>
                            </div>
                          )}

                          {/* Skip */}
                          {!callOutcome && (
                            <Button
                              variant="ghost"
                              className="w-full text-xs text-muted-foreground"
                              onClick={() => handleSkipPhoneCall(task.id)}
                              disabled={isTaskSubmitting}
                            >
                              Skip this call for now
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Bulk Confirmation Dialog ────────── */}
      <Dialog open={!!showBulkConfirm} onOpenChange={(open) => !open && setShowBulkConfirm(null)}>
        <DialogContent className="bg-card border max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {showBulkConfirm?.action === "APPROVE" ? "Bulk Approve" : "Bulk Dismiss"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {showBulkConfirm?.action === "APPROVE"
                ? `This will approve ${bulkSelected.size} proposal${bulkSelected.size !== 1 ? "s" : ""} and execute them immediately. Each will be sent as-is (no draft edits).`
                : `This will dismiss ${bulkSelected.size} proposal${bulkSelected.size !== 1 ? "s" : ""} with reason: "${showBulkConfirm?.reason || "not specified"}".`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowBulkConfirm(null)} disabled={bulkSubmitting}>
              Cancel
            </Button>
            <Button
              variant={showBulkConfirm?.action === "APPROVE" ? "default" : "destructive"}
              size="sm"
              onClick={handleBulkAction}
              disabled={bulkSubmitting}
              className={showBulkConfirm?.action === "APPROVE" ? "bg-green-600 hover:bg-green-700" : ""}
            >
              {bulkSubmitting && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {showBulkConfirm?.action === "APPROVE" ? `Approve ${bulkSelected.size}` : `Dismiss ${bulkSelected.size}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Destructive Confirmation Dialog ── */}
      <Dialog open={!!showDestructiveConfirm} onOpenChange={(open) => !open && setShowDestructiveConfirm(null)}>
        <DialogContent className="bg-card border max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">{showDestructiveConfirm?.title}</DialogTitle>
            <DialogDescription className="text-xs">
              {showDestructiveConfirm?.description}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowDestructiveConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={() => showDestructiveConfirm?.onConfirm()}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddCorrespondenceDialog
        open={showAddCorrespondenceDialog}
        onOpenChange={setShowAddCorrespondenceDialog}
        caseId={addCorrespondenceCaseId || selectedCaseId || 0}
        onSuccess={() => {
          if (addCorrespondenceCaseId) {
            void openCorrespondence(addCorrespondenceCaseId);
          }
          revalidateQueue();
        }}
      />

      {/* ── Adjust Modal ───────────────────── */}
      <Dialog open={showAdjustModal} onOpenChange={setShowAdjustModal}>
        <DialogContent className="bg-card border">
          <DialogHeader>
            <DialogTitle className="text-sm">Adjust Proposal</DialogTitle>
            <DialogDescription className="text-xs">
              Provide instructions for the AI to regenerate this draft
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., Make tone more formal, reference the statute, reduce fee amount..."
            ref={adjustInstructionRef}
            value={adjustInstruction}
            onChange={(e) => setAdjustInstruction(e.target.value)}
            onInput={(e) => setAdjustInstruction((e.target as HTMLTextAreaElement).value)}
            className="min-h-[100px] text-xs bg-background"
          />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAdjustModal(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleAdjust}
              disabled={!canTakeAction || !getAdjustInstructionText().trim() || isSubmitting}
            >
              {isSubmitting ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Edit className="h-3 w-3 mr-1" />
              )}
              Adjust
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Correspondence is now shown inline, no dialog needed */}

      {/* ── Dismiss Reason Dialog (keyboard shortcut D) ── */}
      <Dialog open={showDismissDialog} onOpenChange={setShowDismissDialog}>
        <DialogContent className="bg-card border max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Dismiss Proposal</DialogTitle>
            <DialogDescription className="text-xs">
              Select a reason for dismissing this proposal
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            {DISMISS_REASONS.map((reason, idx) => (
              <button
                key={reason}
                onClick={() => {
                  setShowDismissDialog(false);
                  handleDismiss(reason);
                }}
                className="text-left text-xs px-3 py-2 rounded hover:bg-muted/50 transition-colors flex items-center justify-between"
              >
                <span>{reason}</span>
                <span className="text-[10px] text-muted-foreground font-mono">{idx + 1}</span>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowDismissDialog(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Keyboard Shortcuts Help Overlay ── */}
      <Dialog open={showShortcutsHelp} onOpenChange={setShowShortcutsHelp}>
        <DialogContent className="bg-card border max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Keyboard Shortcuts</DialogTitle>
            <DialogDescription className="text-xs">
              Navigate and act on the approval queue without a mouse
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">Navigation</p>
              <div className="space-y-1.5">
                {([
                  { keys: ["\u2190", "\u2192"], label: "Previous / next item" },
                  { keys: ["\u2191", "\u2193"], label: "Previous / next item" },
                  { keys: ["J", "K"], label: "Next / previous item" },
                ] as const).map((row, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{row.label}</span>
                    <div className="flex items-center gap-1">
                      {row.keys.map((k) => (
                        <kbd key={k} className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded border border-border bg-muted/50 text-[10px] font-mono">
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t pt-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">Actions (proposals)</p>
              <div className="space-y-1.5">
                {([
                  { keys: ["A"], label: "Approve selected proposal" },
                  { keys: ["D"], label: "Dismiss selected proposal" },
                ] as const).map((row, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{row.label}</span>
                    <div className="flex items-center gap-1">
                      {row.keys.map((k) => (
                        <kbd key={k} className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded border border-border bg-muted/50 text-[10px] font-mono">
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t pt-3">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">General</p>
              <div className="space-y-1.5">
                {([
                  { keys: ["Esc"], label: "Close dialog / modal" },
                  { keys: ["?"], label: "Show this help" },
                ] as const).map((row, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-muted-foreground">{row.label}</span>
                    <div className="flex items-center gap-1">
                      {row.keys.map((k) => (
                        <kbd key={k} className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded border border-border bg-muted/50 text-[10px] font-mono">
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Undo Toast ────────────────────── */}
      {pendingAction && (
        <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-96 z-50 px-4 py-3 rounded-md shadow-lg border bg-zinc-900/95 border-zinc-700/50 text-sm flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center gap-2 min-w-0">
            <Clock className="h-4 w-4 text-amber-400 flex-shrink-0" />
            <span className="text-zinc-300 truncate">{pendingAction.label}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="flex-shrink-0 text-xs border-amber-700/50 text-amber-400 hover:bg-amber-950/30"
            onClick={cancelPendingAction}
          >
            <Undo2 className="h-3 w-3 mr-1" /> UNDO
          </Button>
        </div>
      )}

      {/* ── Toast notification ────────────── */}
      {toast && !pendingAction && (
        <div
          className={cn(
            "fixed bottom-4 left-4 z-50 px-4 py-2.5 rounded-md shadow-lg border text-xs font-medium flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-200",
            toast.type === "success"
              ? "bg-green-950/90 border-green-700/50 text-green-300"
              : "bg-red-950/90 border-red-700/50 text-red-300"
          )}
          onClick={() => setToast(null)}
        >
          {toast.type === "success" ? (
            <CheckCircle className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          {toast.message}
        </div>
      )}

      {/* ── Keyboard shortcut hint ────────── */}
      {activeTab === "queue" && queue.length > 0 && (
        <div className="fixed bottom-4 right-4 z-30">
          <button
            onClick={() => setShowShortcutsHelp(true)}
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-1.5"
          >
            Keyboard shortcuts:
            <kbd className="inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded border border-border/50 bg-muted/30 text-[10px] font-mono">
              ?
            </kbd>
          </button>
        </div>
      )}
    </div>
  );
}

export default function MonitorPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-[80vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    }>
      <MonitorPageContent />
    </Suspense>
  );
}
