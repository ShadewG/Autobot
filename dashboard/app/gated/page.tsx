"use client";

import { useState, useMemo, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import { useUserFilter } from "@/components/user-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { cn, formatRelativeTime } from "@/lib/utils";
import type { ThreadMessage } from "@/lib/types";
import { Thread } from "@/components/thread";
import {
  Loader2,
  CheckCircle,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
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
} from "lucide-react";

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
  last_inbound_preview: string | null;
  last_inbound_subject: string | null;
  inbound_count: number;
  trigger_message_id: number | null;
  portal_url?: string | null;
  agency_email?: string | null;
  user_id?: number | null;
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
  ai_briefing: string | null;
  assigned_to: string | null;
  case_name?: string | null;
  agency_name?: string | null;
  created_at?: string;
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
  ESCALATE: "ESCALATE",
};

function getApproveLabel(actionType: string | null): string {
  if (!actionType) return "APPROVE & EXECUTE";
  return ACTION_LABELS[actionType] || `APPROVE: ${actionType.replace(/_/g, " ")}`;
}

function getActionExplanation(actionType: string | null, hasDraft: boolean): string {
  if (!actionType) return "Approve this proposal to execute it.";
  const explanations: Record<string, string> = {
    SEND_REBUTTAL: "Will send a rebuttal challenging the agency's denial, citing relevant statutes.",
    SEND_APPEAL: "Will file a formal appeal of the agency's denial.",
    SEND_FOLLOWUP: "Will send a follow-up email asking for a status update.",
    SEND_INITIAL_REQUEST: "Will send the initial FOIA/public records request to the agency.",
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
    ESCALATE: "Will escalate this case for manual intervention.",
  };
  let explanation = explanations[actionType] || `Will execute: ${actionType.replace(/_/g, " ").toLowerCase()}.`;
  if (!hasDraft && actionType.startsWith("SEND")) {
    explanation += " The AI will generate the draft before sending.";
  }
  return explanation;
}

function getPauseReason(item: QueueItem): string | null {
  if (item.type === "proposal") {
    return item.data.proposal_pause_reason || item.data.case_pause_reason || null;
  }
  return item.data.status || null;
}

type ReviewCategory = "fee" | "portal" | "denial" | "general";

function categorizeReview(review: HumanReviewCase): ReviewCategory {
  const pr = (review.pause_reason || "").toUpperCase();
  const sub = (review.substatus || "").toUpperCase();
  const status = (review.status || "").toUpperCase();

  if (pr.includes("FEE") || sub.includes("FEE") || status.includes("FEE") || review.last_fee_quote_amount != null) return "fee";
  if (pr.includes("PORTAL") || sub.includes("PORTAL") || status.includes("PORTAL") || review.portal_url) return "portal";
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
   Main Component
   ───────────────────────────────────────────── */

function MonitorPageContent() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [adjustInstruction, setAdjustInstruction] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [showCorrespondence, setShowCorrespondence] = useState(false);
  const [correspondenceMessages, setCorrespondenceMessages] = useState<ThreadMessage[]>([]);
  const [correspondenceLoading, setCorrespondenceLoading] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("queue");
  const [reviewInstruction, setReviewInstruction] = useState("");
  const initialCaseApplied = useRef(false);

  // ── Deep linking & user filter ─────────────
  const searchParams = useSearchParams();
  const { appendUser } = useUserFilter();

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

  // Build the queue: proposals first, then human review cases
  const queue = useMemo<QueueItem[]>(() => {
    if (!overview) return [];
    const proposals: QueueItem[] = (overview.pending_approvals || []).map((p) => ({
      type: "proposal" as const,
      data: p,
    }));
    const reviews: QueueItem[] = (overview.human_review_cases || []).map((r) => ({
      type: "review" as const,
      data: r,
    }));
    return [...proposals, ...reviews];
  }, [overview]);

  // Clamp index when queue shrinks
  const safeIndex = queue.length === 0 ? 0 : Math.min(currentIndex, queue.length - 1);
  useEffect(() => {
    if (safeIndex !== currentIndex) setCurrentIndex(safeIndex);
  }, [safeIndex, currentIndex]);
  const selectedItem = queue[safeIndex] || null;

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
    if (idx >= 0) setCurrentIndex(idx);
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

  // ── Inbound / Phone data (lazy: only fetch when tab is active) ──

  const { data: inboundData, mutate: mutateInbound } = useSWR<InboundResponse>(
    activeTab === "inbound" ? appendUser("/api/monitor/inbound?limit=100") : null,
    { refreshInterval: 30000 }
  );

  const { data: phoneData, mutate: mutatePhone } = useSWR<PhoneCallsResponse>(
    activeTab === "calls" ? appendUser("/api/phone-calls?status=pending&limit=50") : null,
    { refreshInterval: 30000 }
  );

  // ── SSE ────────────────────────────────────

  const sseUrl = appendUser("/api/monitor/events");
  const sseConnected = useSSE(sseUrl, () => {
    mutate();
    if (activeTab === "inbound") mutateInbound();
    if (activeTab === "calls") mutatePhone();
  });

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
      if (
        showAdjustModal ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigate(-1);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigate(1);
      }
      // Quick approve with 'a' (only if not already submitting)
      if (e.key === "a" && selectedItem?.type === "proposal" && !isSubmitting) {
        e.preventDefault();
        handleApprove();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, showAdjustModal, selectedItem, isSubmitting]);

  // ── Actions ────────────────────────────────

  const handleApprove = async () => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    setIsSubmitting(true);
    setLastAction(null);
    try {
      const res = await fetch(
        `/api/monitor/proposals/${selectedItem.data.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "APPROVE" }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      setLastAction("Approved");
      mutate();
      // Advance index or stay (item removed from queue)
      if (currentIndex >= queue.length - 1 && currentIndex > 0) {
        setCurrentIndex(currentIndex - 1);
      }
    } catch (err) {
      alert(`Approve failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDismiss = async (reason: string) => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    setIsSubmitting(true);
    setLastAction(null);
    try {
      const res = await fetch(
        `/api/monitor/proposals/${selectedItem.data.id}/decision`,
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
      setLastAction(`Dismissed: ${reason}`);
      mutate();
      if (currentIndex >= queue.length - 1 && currentIndex > 0) {
        setCurrentIndex(currentIndex - 1);
      }
    } catch (err) {
      alert(`Dismiss failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAdjust = async () => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    if (!adjustInstruction.trim()) return;
    setIsSubmitting(true);
    setLastAction(null);
    try {
      const res = await fetch(
        `/api/monitor/proposals/${selectedItem.data.id}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ADJUST",
            instruction: adjustInstruction.trim(),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      setLastAction("Adjusted — regenerating draft");
      setShowAdjustModal(false);
      setAdjustInstruction("");
      mutate();
    } catch (err) {
      alert(`Adjust failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdraw = async () => {
    if (!selectedItem) return;
    const caseId =
      selectedItem.type === "proposal"
        ? selectedItem.data.case_id
        : selectedItem.data.id;
    if (!confirm(`Withdraw case #${caseId}? This closes the request.`)) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/requests/${caseId}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Withdrawn from monitor queue" }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      setLastAction("Withdrawn");
      mutate();
    } catch (err) {
      alert(`Withdraw failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCorrespondence = async (caseId: number) => {
    setShowCorrespondence(true);
    setCorrespondenceLoading(true);
    setCorrespondenceMessages([]);
    try {
      const res = await fetch(`/api/requests/${caseId}/workspace`);
      const data = await res.json();
      if (data.success && data.thread_messages) {
        setCorrespondenceMessages(data.thread_messages);
      }
    } catch (err) {
      console.error("Failed to load correspondence:", err);
    } finally {
      setCorrespondenceLoading(false);
    }
  };

  const handleResolveReview = async (action: string, instruction?: string) => {
    if (!selectedItem || selectedItem.type !== "review") return;
    setIsSubmitting(true);
    setLastAction(null);
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
      const labels: Record<string, string> = {
        reprocess: "Re-processing case",
        put_on_hold: "Put on hold",
        close: "Closed",
        accept_fee: "Accepting fee",
        negotiate_fee: "Negotiating fee",
        decline_fee: "Declining fee",
        appeal: "Drafting appeal",
        narrow_scope: "Narrowing scope",
        retry_portal: "Retrying portal",
        send_via_email: "Switching to email",
        mark_sent: "Marked as sent",
      };
      setLastAction(labels[action] || `Resolved: ${action}`);
      setReviewInstruction("");
      mutate();
      if (currentIndex >= queue.length - 1 && currentIndex > 0) {
        setCurrentIndex(currentIndex - 1);
      }
    } catch (err) {
      alert(`Resolve failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Extract display data ───────────────────

  const summary = overview?.summary;
  const totalAttention = (summary?.pending_approvals_total || 0) + (summary?.human_review_total || 0);

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

  const reasoning = (() => {
    if (selectedItem?.type !== "proposal") return [];
    if (proposalDetail?.proposal?.reasoning) return proposalDetail.proposal.reasoning;
    return formatReasoning(selectedItem.data.reasoning);
  })();

  const riskFlags = (() => {
    if (selectedItem?.type !== "proposal") return [];
    // Prefer detail data (more complete), fall back to overview
    const detailFlags = proposalDetail?.proposal?.risk_flags;
    const overviewFlags = selectedItem.data.risk_flags;
    return (detailFlags && detailFlags.length > 0 ? detailFlags : overviewFlags) || [];
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
          value={totalAttention}
          icon={AlertCircle}
          color={totalAttention > 0 ? "text-amber-400" : "text-green-400"}
          onClick={() => setActiveTab("queue")}
          active={activeTab === "queue"}
        />
        <StatBox
          label="Proposals"
          value={summary?.pending_approvals_total ?? 0}
          icon={FileText}
          color="text-blue-400"
        />
        <StatBox
          label="Review"
          value={summary?.human_review_total ?? 0}
          icon={Shield}
          color="text-purple-400"
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
        />
        <StatBox
          label="Active Runs"
          value={summary?.active_runs_total ?? 0}
          icon={Activity}
          color="text-muted-foreground"
        />
      </div>

      {/* ── Tab Bar ─────────────────────────── */}
      <div className="flex items-center gap-0 border-b mb-4">
        {([
          { id: "queue" as TabId, label: "QUEUE", icon: AlertCircle, count: totalAttention },
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
          <Button variant="ghost" size="sm" onClick={() => mutate()} title="Refresh">
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* ── Last Action Toast ──────────────── */}
      {lastAction && (
        <div className="border border-green-700/50 bg-green-500/10 text-green-300 text-xs p-2 mb-4 flex items-center gap-2">
          <CheckCircle className="h-3 w-3" />
          {lastAction}
          <button
            className="ml-auto text-green-400/60 hover:text-green-300"
            onClick={() => setLastAction(null)}
          >
            dismiss
          </button>
        </div>
      )}

      {/* ── Empty State ────────────────────── */}
      {queue.length === 0 && (
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
      {selectedItem?.type === "proposal" && (
        <div className="space-y-4">
          {/* Case header */}
          <div className="border-b pb-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-mono">
                    #{selectedItem.data.case_id}
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
                  href={`/requests/detail?id=${selectedItem.data.case_id}`}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" /> Case
                </Link>
                <span className="text-[10px] text-muted-foreground">
                  {formatRelativeTime(selectedItem.data.created_at)}
                </span>
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
                ${feeAmount.toFixed(2)} fee
              </Badge>
            )}
          </div>

          {/* Portal details — shown when action involves portal submission */}
          {(selectedItem.data.action_type?.includes("PORTAL") || selectedItem.data.portal_url) && (
            <div className="border border-blue-700/50 bg-blue-950/20 p-3">
              <SectionLabel>Portal Submission</SectionLabel>
              {selectedItem.data.portal_url ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={selectedItem.data.portal_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" /> {selectedItem.data.portal_url}
                  </a>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No portal URL on file for this case
                </p>
              )}
              {selectedItem.data.agency_email && (
                <p className="text-xs text-muted-foreground mt-1">
                  Agency email: {selectedItem.data.agency_email}
                </p>
              )}
            </div>
          )}

          {/* Risk flags */}
          {riskFlags.length > 0 && (
            <div className="border border-amber-700/50 bg-amber-950/20 p-3">
              <p className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider flex items-center gap-1 mb-1.5">
                <AlertTriangle className="h-3 w-3" /> Risk Flags
              </p>
              <div className="flex flex-wrap gap-1">
                {riskFlags.map((flag, i) => (
                  <Badge
                    key={i}
                    variant="outline"
                    className="text-[10px] text-amber-400 border-amber-700/50"
                  >
                    {flag.replace(/_/g, " ")}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="border border-orange-700/50 bg-orange-950/20 p-3">
              <p className="text-[10px] font-semibold text-orange-400 uppercase tracking-wider mb-1.5">
                Warnings
              </p>
              {warnings.map((w, i) => (
                <p key={i} className="text-xs text-orange-300">
                  - {w}
                </p>
              ))}
            </div>
          )}

          {/* Reasoning */}
          {reasoning.length > 0 && (
            <div className="border p-3">
              <SectionLabel>Reasoning</SectionLabel>
              {reasoning.map((r, i) => (
                <p key={i} className="text-xs text-foreground/80 mb-1">
                  <span className="text-muted-foreground mr-1.5 tabular-nums">
                    {i + 1}.
                  </span>
                  {typeof r === "string" ? r : JSON.stringify(r)}
                </p>
              ))}
            </div>
          )}

          {/* Inbound message preview */}
          {selectedItem.data.last_inbound_preview && (
            <div className="border p-3">
              <div className="flex items-center justify-between mb-1.5">
                <SectionLabel>Inbound</SectionLabel>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => openCorrespondence(selectedItem.data.case_id)}
                >
                  <MessageSquare className="h-3 w-3 mr-1" />
                  See Full Correspondence
                </Button>
              </div>
              {selectedItem.data.last_inbound_subject && (
                <p className="text-xs mb-1.5">
                  <span className="text-muted-foreground">Subj:</span>{" "}
                  {selectedItem.data.last_inbound_subject}
                </p>
              )}
              <div className="bg-background border p-2 max-h-72 overflow-auto">
                <pre className="text-xs whitespace-pre-wrap font-[inherit] text-foreground/80">
                  {selectedItem.data.last_inbound_preview}
                </pre>
              </div>
            </div>
          )}

          {/* Draft response */}
          <div className="border p-3">
            <SectionLabel>Draft Response</SectionLabel>
            {draftSubject && (
              <p className="text-xs mb-2">
                <span className="text-muted-foreground">Subj:</span>{" "}
                {draftSubject}
              </p>
            )}
            <div className="bg-background border p-2 max-h-64 overflow-auto">
              <pre className="text-xs whitespace-pre-wrap font-[inherit]">
                {draftBody || (selectedProposalId && !proposalDetail ? "(loading draft...)" : "(no draft)")}
              </pre>
            </div>
          </div>

          {/* Action buttons */}
          <div className="border-t pt-4 space-y-2">
            {/* Action explanation */}
            <p className="text-[10px] text-muted-foreground">
              {getActionExplanation(selectedItem.data.action_type, !!draftBody)}
            </p>
            <div className="flex gap-2">
              <Button
                className="flex-1 bg-green-700 hover:bg-green-600 text-white"
                onClick={handleApprove}
                disabled={isSubmitting}
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
              <Button
                variant="outline"
                onClick={() => setShowAdjustModal(true)}
                disabled={isSubmitting}
              >
                <Edit className="h-3 w-3 mr-1" /> ADJUST
              </Button>
            </div>
            <div className="flex gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={isSubmitting}
                  >
                    <Trash2 className="h-3 w-3 mr-1" /> DISMISS
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
              <Button
                variant="destructive"
                className="flex-1"
                onClick={handleWithdraw}
                disabled={isSubmitting}
              >
                <Ban className="h-3 w-3 mr-1" /> WITHDRAW
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Human Review View ──────────────── */}
      {selectedItem?.type === "review" && (
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
                  href={`/requests/detail?id=${selectedItem.data.id}`}
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

          {/* Substatus / reason */}
          {selectedItem.data.substatus && (
            <div className="border border-purple-700/50 bg-purple-950/20 p-3">
              <SectionLabel>Review Reason</SectionLabel>
              <p className="text-xs text-purple-300">
                {selectedItem.data.substatus}
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
          {selectedItem.data.portal_url && (
            <div className="border p-3">
              <SectionLabel>Portal</SectionLabel>
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={selectedItem.data.portal_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" /> Open Portal
                </a>
                {selectedItem.data.last_portal_status && (
                  <Badge variant="outline" className="text-[10px] text-red-400 border-red-700/50">
                    {selectedItem.data.last_portal_status}
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Inbound preview */}
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
                  See Full Correspondence
                </Button>
              </div>
              <div className="bg-background border p-2 max-h-48 overflow-auto">
                <pre className="text-xs whitespace-pre-wrap font-[inherit] text-foreground/80">
                  {selectedItem.data.last_inbound_preview}
                </pre>
              </div>
              {selectedItem.data.inbound_count > 0 && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  {selectedItem.data.inbound_count} inbound message(s) total
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

                {/* Custom instruction */}
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Custom instruction (optional)..."
                    value={reviewInstruction}
                    onChange={(e) => setReviewInstruction(e.target.value)}
                    className="text-xs bg-background min-h-[60px] flex-1"
                  />
                  <Button
                    variant="outline"
                    className="self-end"
                    onClick={() => handleResolveReview("custom", reviewInstruction)}
                    disabled={isSubmitting || !reviewInstruction.trim()}
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
                      if (confirm(`Close case #${selectedItem.data.id}?`)) handleResolveReview("close");
                    }}
                    disabled={isSubmitting}
                  >
                    CLOSE
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleWithdraw}
                    disabled={isSubmitting}
                  >
                    <Ban className="h-3 w-3 mr-1" /> WITHDRAW
                  </Button>
                  <Link href={`/requests/detail?id=${selectedItem.data.id}`}>
                    <Button variant="ghost" className="text-xs text-muted-foreground">
                      <ExternalLink className="h-3 w-3 mr-1" /> Full Case
                    </Button>
                  </Link>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Unmatched Inbound Summary ──────── */}
      {overview && (overview.unmatched_inbound?.length ?? 0) > 0 && queue.length === 0 && (
        <div className="mt-6 border p-4">
          <SectionLabel>Unmatched Inbound ({overview.unmatched_inbound.length})</SectionLabel>
          <div className="space-y-2 mt-2">
            {overview.unmatched_inbound.slice(0, 5).map((m) => (
              <div key={m.id} className="border p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-foreground">
                    {m.from_email}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {formatRelativeTime(m.received_at || m.created_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 truncate">
                  {m.subject}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      </>)}

      {/* ── Inbound Tab ────────────────────── */}
      {activeTab === "inbound" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
              Recent Inbound Messages
            </span>
            <Button variant="ghost" size="sm" onClick={() => mutateInbound()} title="Refresh">
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          {!inboundData ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : inboundData.inbound.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-sm text-muted-foreground">
              No inbound messages found.
            </div>
          ) : (
            <div className="border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Case</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">From</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Subject</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Intent</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Action</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">Tone</th>
                    <th className="text-right px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">When</th>
                  </tr>
                </thead>
                <tbody>
                  {inboundData.inbound.map((msg) => (
                    <tr key={msg.id} className="border-b last:border-b-0 hover:bg-muted/20">
                      <td className="px-3 py-2">
                        {msg.case_id ? (
                          <Link
                            href={`/requests/detail?id=${msg.case_id}`}
                            className="text-blue-400 hover:underline flex items-center gap-1"
                          >
                            #{msg.case_id}
                            <ArrowUpRight className="h-2.5 w-2.5" />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-[160px] truncate" title={msg.from_email}>
                        {msg.from_email}
                      </td>
                      <td className="px-3 py-2 max-w-[200px] truncate" title={msg.subject}>
                        {msg.subject}
                      </td>
                      <td className="px-3 py-2">
                        {msg.intent ? (
                          <Badge variant="outline" className="text-[10px]">
                            {msg.intent.replace(/_/g, " ")}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {msg.suggested_action ? (
                          <Badge variant="outline" className="text-[10px] text-cyan-400 border-cyan-700/50">
                            {msg.suggested_action.replace(/_/g, " ")}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {msg.sentiment ? (
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
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap">
                        {formatRelativeTime(msg.received_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
            <div className="space-y-3">
              {phoneData.tasks.map((task) => (
                <div key={task.id} className="border p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Phone className="h-3.5 w-3.5 text-amber-400" />
                      <Link
                        href={`/requests/detail?id=${task.case_id}`}
                        className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                      >
                        #{task.case_id} {task.case_name || ""}
                        <ArrowUpRight className="h-2.5 w-2.5" />
                      </Link>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        task.status === "pending" && "text-amber-400 border-amber-700/50",
                        task.status === "claimed" && "text-blue-400 border-blue-700/50",
                        task.status === "completed" && "text-green-400 border-green-700/50"
                      )}
                    >
                      {task.status.toUpperCase()}
                    </Badge>
                  </div>
                  {task.agency_name && (
                    <p className="text-xs text-muted-foreground mb-1">{task.agency_name}</p>
                  )}
                  {task.agency_phone && (
                    <p className="text-xs mb-1">
                      <span className="text-muted-foreground">Phone:</span>{" "}
                      <span className="text-foreground font-mono">{task.agency_phone}</span>
                    </p>
                  )}
                  {task.reason && (
                    <p className="text-xs mb-2">
                      <span className="text-muted-foreground">Reason:</span> {task.reason}
                    </p>
                  )}
                  {task.ai_briefing && (
                    <div className="bg-muted/30 border p-2 mt-2">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">AI Briefing</p>
                      <p className="text-xs text-foreground/80 whitespace-pre-wrap">{task.ai_briefing}</p>
                    </div>
                  )}
                  {task.assigned_to && (
                    <p className="text-[10px] text-muted-foreground mt-2">
                      Assigned to: {task.assigned_to}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
            value={adjustInstruction}
            onChange={(e) => setAdjustInstruction(e.target.value)}
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
              disabled={!adjustInstruction.trim() || isSubmitting}
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

      {/* ── Correspondence Dialog ─────────── */}
      <Dialog open={showCorrespondence} onOpenChange={setShowCorrespondence}>
        <DialogContent className="bg-card border max-w-4xl w-[90vw] h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="text-sm flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Full Correspondence
            </DialogTitle>
            <DialogDescription className="text-xs">
              {correspondenceMessages.length > 0
                ? `${correspondenceMessages.length} message${correspondenceMessages.length !== 1 ? "s" : ""} in thread`
                : "Loading..."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            {correspondenceLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : correspondenceMessages.length > 0 ? (
              <Thread messages={correspondenceMessages} maxHeight="h-full" />
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">
                No messages found
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
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
