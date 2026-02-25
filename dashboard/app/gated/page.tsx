"use client";

import { useState, useMemo, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import { useUserFilter } from "@/components/user-filter";
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
    notion?: { phone: string; source: string; pd_page_url?: string };
    web_search?: { phone: string; source: string; confidence?: string; reasoning?: string };
  } | null;
  created_at?: string;
  case_status?: string | null;
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

function getActionExplanation(actionType: string | null, hasDraft: boolean, portalUrl?: string | null, agencyEmail?: string | null): string {
  if (!actionType) return "Approve this proposal to execute it.";
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
    ESCALATE: "Will escalate this case for manual intervention.",
  };
  let explanation = explanations[actionType] || `Will execute: ${actionType.replace(/_/g, " ").toLowerCase()}.`;
  if (!hasDraft && actionType.startsWith("SEND")) {
    explanation += " The AI will generate the draft before sending.";
  }
  // Add delivery target for clarity
  if (actionType === "SUBMIT_PORTAL" && portalUrl) {
    explanation += ` Target: ${portalUrl}`;
  } else if (actionType.startsWith("SEND") && agencyEmail) {
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
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
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

  // Build the queue: proposals first, then human review cases — filter out acted-on items
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
    return [...proposals, ...reviews].filter((item) => {
      const key = item.type === "proposal" ? `p:${item.data.id}` : `r:${item.data.id}`;
      return !removedIds.has(key);
    });
  }, [overview, removedIds]);

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
      setShowCorrespondence(false);
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

  // Optimistically remove current item from queue and advance to next
  const removeCurrentItem = useCallback(() => {
    if (!selectedItem) return;
    const key = selectedItem.type === "proposal" ? `p:${selectedItem.data.id}` : `r:${selectedItem.data.id}`;
    setRemovedIds((prev) => new Set(prev).add(key));
    // If we're at the end, move back; otherwise stay (next item slides in)
    if (currentIndex >= queue.length - 1 && currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [selectedItem, currentIndex, queue.length]);

  // Background revalidate + clear removedIds once server data is fresh
  const revalidateQueue = useCallback(() => {
    mutate().then(() => setRemovedIds(new Set()));
  }, [mutate]);

  const handleApprove = async () => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    setIsSubmitting(true);
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
      removeCurrentItem();
      revalidateQueue();
    } catch (err) {
      alert(`Approve failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDismiss = async (reason: string) => {
    if (!selectedItem || selectedItem.type !== "proposal") return;
    setIsSubmitting(true);
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
      removeCurrentItem();
      revalidateQueue();
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
      setShowAdjustModal(false);
      setAdjustInstruction("");
      removeCurrentItem();
      revalidateQueue();
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
      removeCurrentItem();
      revalidateQueue();
    } catch (err) {
      alert(`Withdraw failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
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
      alert(`Match failed: ${err instanceof Error ? err.message : err}`);
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

  const handleResolveReview = async (action: string, instruction?: string) => {
    if (!selectedItem || selectedItem.type !== "review") return;
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
      revalidateQueue();
    } catch (err) {
      alert(`Resolve failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Phone Queue Helpers ────────────────────

  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

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

  const handleClaimPhoneCall = async (taskId: number) => {
    setPhoneCallSubmitting(taskId);
    try {
      const res = await fetch(`/api/phone-calls/${taskId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: "dashboard" }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      mutatePhone();
    } catch (err) {
      alert(`Claim failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setPhoneCallSubmitting(null);
    }
  };

  const handleCompletePhoneCall = async (taskId: number, outcome: string) => {
    const notes = prompt("Call notes (optional):");
    setPhoneCallSubmitting(taskId);
    try {
      const res = await fetch(`/api/phone-calls/${taskId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, notes: notes || undefined, completedBy: "dashboard" }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      mutatePhone();
    } catch (err) {
      alert(`Complete failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setPhoneCallSubmitting(null);
    }
  };

  const handleSkipPhoneCall = async (taskId: number) => {
    const notes = prompt("Skip reason (optional):");
    setPhoneCallSubmitting(taskId);
    try {
      const res = await fetch(`/api/phone-calls/${taskId}/skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed (${res.status})`);
      }
      mutatePhone();
    } catch (err) {
      alert(`Skip failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setPhoneCallSubmitting(null);
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

  const INTERNAL_FLAGS = new Set(["NO_DRAFT", "MISSING_DRAFT", "DRAFT_EMPTY"]);
  const riskFlags = (() => {
    if (selectedItem?.type !== "proposal") return [];
    // Prefer detail data (more complete), fall back to overview
    const detailFlags = proposalDetail?.proposal?.risk_flags;
    const overviewFlags = selectedItem.data.risk_flags;
    const raw = (detailFlags && detailFlags.length > 0 ? detailFlags : overviewFlags) || [];
    return raw.filter((f: string) => !INTERNAL_FLAGS.has(f));
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

          {/* Delivery method — always show for actionable proposals */}
          {selectedItem.data.action_type && (
            <div className={cn(
              "border p-3",
              selectedItem.data.action_type === "SUBMIT_PORTAL"
                ? "border-blue-700/50 bg-blue-950/20"
                : selectedItem.data.action_type.startsWith("SEND")
                ? "border-emerald-700/50 bg-emerald-950/20"
                : "border-zinc-700/50 bg-zinc-950/20"
            )}>
              <SectionLabel>
                {selectedItem.data.action_type === "SUBMIT_PORTAL" ? "Delivery: Portal" :
                 selectedItem.data.action_type.startsWith("SEND") ? "Delivery: Email" :
                 selectedItem.data.action_type === "CLOSE_CASE" ? "Action: Close Case" :
                 selectedItem.data.action_type === "ESCALATE" ? "Action: Escalate" :
                 "Action"}
              </SectionLabel>
              {selectedItem.data.action_type === "SUBMIT_PORTAL" && (
                <>
                  {selectedItem.data.portal_url ? (
                    <a
                      href={selectedItem.data.portal_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                    >
                      <ExternalLink className="h-3 w-3" /> {selectedItem.data.portal_url}
                    </a>
                  ) : (
                    <p className="text-xs text-muted-foreground">No portal URL on file</p>
                  )}
                </>
              )}
              {selectedItem.data.action_type.startsWith("SEND") && (
                <p className="text-xs text-emerald-300">
                  <Mail className="h-3 w-3 inline mr-1" />
                  {selectedItem.data.agency_email || "No email on file"}
                </p>
              )}
              {selectedItem.data.action_type === "CLOSE_CASE" && (
                <p className="text-xs text-muted-foreground">Will mark this case as closed/denial accepted.</p>
              )}
              {selectedItem.data.action_type === "ESCALATE" && (
                <p className="text-xs text-muted-foreground">Will flag for manual review.</p>
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

          {/* Inbound message — full text */}
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
                  {showCorrespondence ? "Hide Correspondence" : "See Full Correspondence"}
                </Button>
              </div>
              {selectedItem.data.last_inbound_subject && (
                <p className="text-xs mb-1.5">
                  <span className="text-muted-foreground">Subj:</span>{" "}
                  {selectedItem.data.last_inbound_subject}
                </p>
              )}
              <div className="bg-background border p-2">
                <pre className="text-xs whitespace-pre-wrap font-[inherit] text-foreground/80">
                  {selectedItem.data.last_inbound_preview}
                </pre>
              </div>
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

          {/* Draft content — only shown when there's actually a draft */}
          {(draftBody || draftSubject || (selectedProposalId && !proposalDetail)) && (
            <div className="border p-3">
              <SectionLabel>
                {selectedItem.data.action_type === "SUBMIT_PORTAL" ? "Portal Submission Text" : "Draft Email"}
              </SectionLabel>
              {draftSubject && (
                <p className="text-xs mb-2">
                  <span className="text-muted-foreground">Subj:</span>{" "}
                  {draftSubject}
                </p>
              )}
              <div className="bg-background border p-2 max-h-64 overflow-auto">
                <pre className="text-xs whitespace-pre-wrap font-[inherit]">
                  {draftBody || "(loading draft...)"}
                </pre>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="border-t pt-4 space-y-2">
            {/* Action explanation */}
            <p className="text-[10px] text-muted-foreground">
              {getActionExplanation(selectedItem.data.action_type, !!draftBody, selectedItem.data.portal_url, selectedItem.data.agency_email)}
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
            {/* Add to phone queue — always available */}
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
              <div className="bg-background border p-2">
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

                {/* Add to phone queue — always available */}
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
                                href={`/requests/detail?id=${msg.case_id}`}
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
                                href={`/requests/detail?id=${msg.case_id}`}
                                className="text-xs text-blue-400 hover:underline"
                              >
                                #{msg.case_id} — {msg.case_name} ({msg.agency_name})
                              </Link>
                            </div>
                          )}

                          {/* Email body */}
                          <div className="bg-background border p-3 max-h-64 overflow-auto">
                            <pre className="text-xs whitespace-pre-wrap font-[inherit] text-foreground/80">
                              {msg.body_text || "(no body text)"}
                            </pre>
                          </div>

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

                return (
                  <div
                    key={task.id}
                    className={cn(
                      "border transition-colors",
                      task.status === "claimed" && "border-blue-700/30 bg-blue-950/5",
                      isExpanded && "ring-1 ring-foreground/20"
                    )}
                  >
                    {/* Row header — clickable to expand */}
                    <button
                      className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-muted/20"
                      onClick={() => setExpandedPhoneCallId(isExpanded ? null : task.id)}
                    >
                      <Phone className={cn(
                        "h-4 w-4 flex-shrink-0",
                        task.status === "claimed" ? "text-blue-400" : "text-amber-400"
                      )} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium">
                            {task.agency_name || `Case #${task.case_id}`}
                          </span>
                          {task.agency_state && (
                            <span className="text-[10px] text-muted-foreground">{task.agency_state}</span>
                          )}
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px]",
                              task.status === "pending" && "text-amber-400 border-amber-700/50",
                              task.status === "claimed" && "text-blue-400 border-blue-700/50"
                            )}
                          >
                            {task.status.toUpperCase()}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3">
                          {task.agency_phone && (
                            <span className="text-xs font-mono text-foreground">{task.agency_phone}</span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {REASON_LABELS[task.reason || ""] || task.reason || ""}
                          </span>
                        </div>
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
                            <p className="text-sm text-muted-foreground italic">No phone number on file</p>
                          )}
                          {/* Phone options if available */}
                          {task.phone_options && (
                            <div className="mt-2 space-y-1">
                              {task.phone_options.notion?.phone && task.phone_options.notion.phone !== task.agency_phone && (
                                <p className="text-[10px] text-muted-foreground">
                                  Notion: <span className="font-mono">{task.phone_options.notion.phone}</span>
                                </p>
                              )}
                              {task.phone_options.web_search?.phone && task.phone_options.web_search.phone !== task.agency_phone && (
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
                          <div className="space-y-1 text-xs">
                            <div className="flex items-center gap-2">
                              <Link
                                href={`/requests/detail?id=${task.case_id}`}
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
                            {task.notes && (
                              <p><span className="text-muted-foreground">Notes:</span> {task.notes}</p>
                            )}
                          </div>
                        </div>

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
                              {typeof briefing === "object" && "talking_points" in briefing && Array.isArray(briefing.talking_points) && (
                                <div>
                                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Talking points</p>
                                  <ul className="space-y-0.5">
                                    {(briefing.talking_points as string[]).map((point, i) => (
                                      <li key={i} className="text-foreground/80 pl-2 border-l-2 border-muted">
                                        {point}
                                      </li>
                                    ))}
                                  </ul>
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
                                    const requestSent = dates.request_sent ? String(dates.request_sent) : null;
                                    return (
                                      <div className="space-y-1 text-foreground/80">
                                        {daysWaiting && (
                                          <p>Waiting: {daysWaiting} days</p>
                                        )}
                                        {requestSent && (
                                          <p>Request sent: {requestSent}</p>
                                        )}
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

                        {/* Correspondence button */}
                        <Button
                          variant="ghost"
                          className="w-full text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => openCorrespondence(task.case_id)}
                        >
                          <MessageSquare className="h-3 w-3 mr-1.5" />
                          View Full Correspondence
                        </Button>

                        {/* Action buttons */}
                        <div className="border-t pt-3 space-y-2">
                          {task.status === "pending" && (
                            <Button
                              className="w-full bg-blue-700 hover:bg-blue-600 text-white"
                              onClick={() => handleClaimPhoneCall(task.id)}
                              disabled={isTaskSubmitting}
                            >
                              {isTaskSubmitting ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Phone className="h-3 w-3 mr-1.5" />}
                              CLAIM CALL
                            </Button>
                          )}
                          {(task.status === "pending" || task.status === "claimed") && (
                            <div className="flex gap-2">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    className="flex-1 bg-green-700 hover:bg-green-600 text-white"
                                    disabled={isTaskSubmitting}
                                  >
                                    <CheckCircle className="h-3 w-3 mr-1.5" />
                                    COMPLETE
                                    <ChevronDown className="h-3 w-3 ml-1" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                  {[
                                    { outcome: "resolved", label: "Resolved" },
                                    { outcome: "connected", label: "Connected / Spoke with someone" },
                                    { outcome: "transferred", label: "Transferred to right dept" },
                                    { outcome: "voicemail", label: "Left voicemail" },
                                    { outcome: "no_answer", label: "No answer" },
                                    { outcome: "wrong_number", label: "Wrong number" },
                                  ].map((opt) => (
                                    <DropdownMenuItem
                                      key={opt.outcome}
                                      onClick={() => handleCompletePhoneCall(task.id, opt.outcome)}
                                      className="text-xs"
                                    >
                                      {opt.label}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>
                              <Button
                                variant="outline"
                                className="flex-1"
                                onClick={() => handleSkipPhoneCall(task.id)}
                                disabled={isTaskSubmitting}
                              >
                                SKIP
                              </Button>
                            </div>
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

      {/* Correspondence is now shown inline, no dialog needed */}

      {/* ── Toast notification ────────────── */}
      {toast && (
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
