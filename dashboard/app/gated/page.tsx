"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import useSWR from "swr";
import Link from "next/link";
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
  Inbox,
  AlertCircle,
  Activity,
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
  inbound_count: number;
  trigger_message_id: number | null;
  portal_url?: string | null;
  agency_email?: string | null;
}

interface HumanReviewCase {
  id: number;
  case_name: string;
  agency_name: string;
  status: string;
  substatus: string | null;
  updated_at: string;
  last_inbound_preview: string | null;
  inbound_count: number;
  last_fee_quote_amount: number | null;
  portal_url: string | null;
  last_portal_status: string | null;
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

function getPauseReason(item: QueueItem): string | null {
  if (item.type === "proposal") {
    return item.data.proposal_pause_reason || item.data.case_pause_reason || null;
  }
  return item.data.status || null;
}

/* ─────────────────────────────────────────────
   SSE Hook
   ───────────────────────────────────────────── */

function useSSE(onEvent: () => void) {
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

      const es = new EventSource("/api/monitor/events");
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
  }, []);

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
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  color?: string;
}) {
  return (
    <div className="border bg-card p-3">
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

export default function MonitorPage() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [adjustInstruction, setAdjustInstruction] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  // ── Data fetching ──────────────────────────

  const {
    data: overview,
    error,
    isLoading,
    mutate,
  } = useSWR<LiveOverview>("/api/monitor/live-overview?limit=25", {
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

  // Fetch full proposal detail for the selected proposal
  const selectedProposalId =
    selectedItem?.type === "proposal" ? selectedItem.data.id : null;
  const { data: proposalDetail } = useSWR<ProposalDetailResponse>(
    selectedProposalId ? `/api/proposals/${selectedProposalId}` : null
  );

  // ── SSE ────────────────────────────────────

  const sseConnected = useSSE(() => {
    mutate();
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
          icon={Inbox}
          color="text-green-400"
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

      {/* ── Queue Header ───────────────────── */}
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
              <SectionLabel>Inbound</SectionLabel>
              <div className="bg-background border p-2 max-h-48 overflow-auto">
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
                APPROVE & EXECUTE
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
              <SectionLabel>Last Inbound</SectionLabel>
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

          {/* Actions for human review */}
          <div className="border-t pt-4">
            <div className="flex gap-2">
              <Link
                href={`/requests/detail?id=${selectedItem.data.id}`}
                className="flex-1"
              >
                <Button className="w-full bg-purple-700 hover:bg-purple-600 text-white">
                  <ExternalLink className="h-3 w-3 mr-1.5" />
                  Open Case to Resolve
                </Button>
              </Link>
              <Button
                variant="destructive"
                onClick={handleWithdraw}
                disabled={isSubmitting}
              >
                <Ban className="h-3 w-3 mr-1" /> WITHDRAW
              </Button>
            </div>
          </div>
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
    </div>
  );
}
