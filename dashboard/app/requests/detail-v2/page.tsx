"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, Suspense, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
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
import { requestsAPI, casesAPI, fetcher, type AgentRun } from "@/lib/api";
import type {
  RequestWorkspaceResponse,
  NextAction,
  AgentDecision,
  CaseAgency,
  AgencyCandidate,
  ThreadMessage,
} from "@/lib/types";
import { formatDate, formatRelativeTime, cn, formatReasoning, ACTION_TYPE_LABELS, formatCurrency } from "@/lib/utils";
import {
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
} from "lucide-react";
import { ProposalStatus, type ProposalState } from "@/components/proposal-status";
import { SnoozeModal } from "@/components/snooze-modal";
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

function CollapsibleSection({ title, defaultOpen = true, count, children }: {
  title: string;
  defaultOpen?: boolean;
  count?: number | null;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen || undefined} className="border-b border-border/50 group">
      <summary className="px-3 py-1.5 cursor-pointer select-none flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-foreground font-medium hover:text-foreground list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90 shrink-0" />
        {title}
        {count != null && <span className="ml-auto text-muted-foreground">{count}</span>}
      </summary>
      <div className="px-3 pb-2">{children}</div>
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
  const [scheduledSendAt, setScheduledSendAt] = useState<string | null>(null);
  const [editedBody, setEditedBody] = useState<string>("");
  const [editedSubject, setEditedSubject] = useState<string>("");
  const [pendingAdjustModalOpen, setPendingAdjustModalOpen] = useState(false);
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
  // Chain draft editing
  const [editedChainSubject, setEditedChainSubject] = useState<string>("");
  const [editedChainBody, setEditedChainBody] = useState<string>("");
  // View management
  const [activeView, setActiveView] = useState<"thread" | "case-info" | "agency">("thread");
  const [bottomDrawer, setBottomDrawer] = useState<"runs" | "agent-log" | null>(null);
  const [conversationTab, setConversationTab] = useState<string>("all");
  // Multi-agency state
  const [agencyActionLoadingId, setAgencyActionLoadingId] = useState<number | null>(null);
  const [agencyStartLoadingId, setAgencyStartLoadingId] = useState<number | null>(null);
  const [candidateActionLoadingName, setCandidateActionLoadingName] = useState<string | null>(null);
  const [candidateStartLoadingName, setCandidateStartLoadingName] = useState<string | null>(null);
  const [manualAgencyName, setManualAgencyName] = useState("");
  const [manualAgencyEmail, setManualAgencyEmail] = useState("");
  const [manualAgencyPortalUrl, setManualAgencyPortalUrl] = useState("");
  const [isManualAgencySubmitting, setIsManualAgencySubmitting] = useState(false);

  // ── Polling ────────────────────────────────────────────────────────────────
  const [pollingUntil, setPollingUntil] = useState<number>(0);
  const refreshInterval = Date.now() < pollingUntil ? 3000 : 0;

  const { data, error, isLoading, mutate } = useSWR<RequestWorkspaceResponse>(
    id ? `/requests/${id}/workspace` : null,
    fetcher,
    { refreshInterval }
  );

  useEffect(() => {
    setNextAction(data?.next_action_proposal || null);
  }, [data?.next_action_proposal]);

  useEffect(() => {
    setEditedBody(data?.pending_proposal?.draft_body_text || "");
    setEditedSubject(data?.pending_proposal?.draft_subject || "");
    const chain = data?.pending_proposal?.action_chain;
    if (chain && chain.length > 1) {
      setEditedChainSubject(chain[1].draftSubject || "");
      setEditedChainBody(chain[1].draftBodyText || "");
    } else {
      setEditedChainSubject("");
      setEditedChainBody("");
    }
  }, [data?.pending_proposal?.draft_body_text, data?.pending_proposal?.draft_subject, data?.pending_proposal?.action_chain]);

  const lastInboundMessage = useMemo(() => {
    if (!data?.thread_messages) return null;
    const inbound = data.thread_messages.filter(m => m.direction === "INBOUND");
    return inbound.length > 0 ? inbound[inbound.length - 1] : null;
  }, [data?.thread_messages]);

  const { data: runsData, mutate: mutateRuns } = useSWR<{ runs: AgentRun[] }>(
    id ? `/requests/${id}/agent-runs` : null,
    fetcher,
    { refreshInterval }
  );

  const startPolling = useCallback(() => {
    setPollingUntil(Date.now() + 30_000);
  }, []);

  const optimisticClear = useCallback(() => {
    mutate(
      (cur) => cur ? {
        ...cur,
        request: { ...cur.request, requires_human: false, pause_reason: null, status: 'AWAITING_RESPONSE' as const },
        pending_proposal: null,
        next_action_proposal: null,
        review_state: 'PROCESSING',
        control_state: 'WORKING',
      } : cur,
      { revalidate: true }
    );
    mutateRuns();
    startPolling();
  }, [mutate, mutateRuns, startPolling]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const _threadMessages = data?.thread_messages || [];
  const _caseAgencies: CaseAgency[] = (data as any)?.case_agencies || [];
  const _activeCaseAgencies = _caseAgencies.filter((ca: CaseAgency) => ca.is_active !== false);

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
  const shouldShowConversationTabs = conversationAgencies.length > 1;

  const conversationBuckets = useMemo(() => {
    const allIds = new Set(_threadMessages.map((m) => m.id));
    const buckets: Array<{ id: string; label: string; count: number; messageIds: Set<number> }> = [
      { id: "all", label: "All", count: _threadMessages.length, messageIds: allIds },
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
    for (const ag of conversationAgencies) {
      const bucketId = `agency-${ag.id}`;
      const messageIds = new Set<number>();
      for (const [msgId, bid] of assigned) {
        if (bid === bucketId) messageIds.add(msgId);
      }
      buckets.push({
        id: bucketId,
        label: ag.agency_name || `Agency ${ag.id}`,
        count: messageIds.size,
        messageIds,
      });
    }

    // "Other" for unassigned messages
    const otherIds = new Set(
      _threadMessages.filter((m) => !assigned.has(m.id)).map((m) => m.id)
    );
    if (otherIds.size > 0) {
      buckets.push({ id: "other", label: "Other", count: otherIds.size, messageIds: otherIds });
    }
    return buckets;
  }, [_threadMessages, conversationAgencies, shouldShowConversationTabs]);

  const agencyMessageStats = useMemo(() => {
    const stats = new Map<number, { total: number; inbound: number; outbound: number; lastMessageAt: string | null }>();
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
      stats.set(agency.id, { total, inbound, outbound, lastMessageAt });
    }
    return stats;
  }, [_threadMessages, _activeCaseAgencies]);

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
    return [...real, ...optimisticMessages];
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
        m.direction === 'OUTBOUND' && m.id > 0 &&
        new Date(m.sent_at).getTime() >= new Date(opt.sent_at).getTime() - 5000
      );
      return !hasReal;
    }));
  }, [_threadMessages]);
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    const timer = setTimeout(() => setOptimisticMessages([]), 120_000);
    return () => clearTimeout(timer);
  }, [optimisticMessages.length]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleApprovePending = async () => {
    if (!data?.pending_proposal) return;
    setIsApproving(true);
    try {
      const body: Record<string, unknown> = { action: "APPROVE" };
      if (editedBody && editedBody !== (data.pending_proposal.draft_body_text || "")) body.draft_body_text = editedBody;
      if (editedSubject && editedSubject !== (data.pending_proposal.draft_subject || "")) body.draft_subject = editedSubject;
      const chain = data.pending_proposal.action_chain;
      if (chain && chain.length > 1) {
        if (editedChainBody && editedChainBody !== (chain[1].draftBodyText || "")) body.chain_draft_body_text = editedChainBody;
        if (editedChainSubject && editedChainSubject !== (chain[1].draftSubject || "")) body.chain_draft_subject = editedChainSubject;
      }
      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      const nonEmailActions = ["RESEARCH_AGENCY", "ESCALATE", "WITHDRAW"];
      const actionType = data.pending_proposal.action_type || "";
      if (!nonEmailActions.includes(actionType) && (editedBody || data.pending_proposal.draft_body_text)) {
        setOptimisticMessages(prev => [...prev, {
          id: -Date.now(), direction: 'OUTBOUND' as const, channel: 'EMAIL' as const,
          from_email: '', to_email: data.request.agency_email || '',
          subject: editedSubject || data.pending_proposal!.draft_subject || '',
          body: editedBody || data.pending_proposal!.draft_body_text || '',
          sent_at: new Date().toISOString(), timestamp: new Date().toISOString(),
          attachments: [], _sending: true as const,
        }]);
        toast.success("Sending...");
      } else {
        toast.success("Approved");
      }
      optimisticClear();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsApproving(false);
    }
  };

  const handleDismissPending = async (reason: string) => {
    if (!data?.pending_proposal) return;
    try {
      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "DISMISS", dismiss_reason: reason }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      optimisticClear();
      toast.success("Proposal dismissed");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleAdjustPending = async (instruction: string) => {
    if (!data?.pending_proposal) return;
    setIsAdjustingPending(true);
    try {
      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ADJUST", instruction: instruction.trim() }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      setPendingAdjustModalOpen(false);
      optimisticClear();
      toast.success("Adjusting draft...");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsAdjustingPending(false);
    }
  };

  const handleRetryResearch = async () => {
    if (!data?.pending_proposal) return;
    setIsApproving(true);
    try {
      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RETRY_RESEARCH" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      optimisticClear();
      toast.success("Research retry started...");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsApproving(false);
    }
  };

  const handleManualSubmit = async () => {
    if (!data?.pending_proposal) return;
    setIsManualSubmitting(true);
    try {
      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "MANUAL_SUBMIT" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      optimisticClear();
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
      if (action === "submit_manually" && data?.request?.portal_url) {
        window.open(data.request.portal_url, "_blank");
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

  const handleSendMessage = async (content: string) => {
    mutate();
  };

  const handleAddToPhoneQueue = async () => {
    if (!id) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/phone-calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: Number(id), reason: "manual_add", notes: "Added from case detail page" }),
      });
      const data = await res.json();
      if (data.already_exists) toast.info("Already in the phone call queue");
      else toast.success("Added to phone call queue");
      mutate();
    } catch (error) {
      toast.error("Failed to add to phone queue");
    }
  };

  // ── Multi-agency handlers ──────────────────────────────────────────────────

  const handleSetPrimaryAgency = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoadingId(caseAgencyId);
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/set-primary`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to set primary agency");
      mutate();
    } catch (e: any) {
      toast.error(e.message || "Failed to set primary agency");
    } finally {
      setAgencyActionLoadingId(null);
    }
  };

  const handleResearchAgency = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoadingId(caseAgencyId);
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/research`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to research agency");
      mutate();
    } catch (e: any) {
      toast.error(e.message || "Failed to research agency");
    } finally {
      setAgencyActionLoadingId(null);
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
      const runResult = await casesAPI.runInitial(caseId, { autopilotMode: "SUPERVISED" });
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
      if (startAfterAdd && caseAgency?.id) {
        await handleStartRequestForAgency(caseAgency.id, caseAgency);
      } else {
        mutate();
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

  // ── Early returns ──────────────────────────────────────────────────────────

  if (!id) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">No request ID provided</p>
        <Link href="/requests" className="text-primary hover:underline mt-4 inline-block">Back to Requests</Link>
      </div>
    );
  }

  if (isLoading) {
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

  const pendingActionType = pending_proposal?.action_type || "";
  const isEmailLikePendingAction = [
    "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_CLARIFICATION", "SEND_REBUTTAL",
    "NEGOTIATE_FEE", "ACCEPT_FEE", "DECLINE_FEE", "SEND_PDF_EMAIL",
  ].includes(pendingActionType);
  const hasChain = (pending_proposal?.action_chain?.length ?? 0) > 1;
  const pendingApproveLabel = hasChain
    ? `Approve ${pending_proposal!.action_chain!.length} Actions`
    : isEmailLikePendingAction ? "Send" : "Approve";
  const pendingDelivery = getDeliveryTarget(pendingActionType || null, request, agency_summary || null);

  const statusValue = String(request.status || "").toUpperCase();
  const isPausedStatus = statusValue === "NEEDS_HUMAN_REVIEW" || statusValue === "PAUSED";
  const statusDisplay = isPausedStatus ? "PAUSED" : (request.status || "—");

  const decisionRequired = review_state
    ? review_state === "DECISION_REQUIRED"
    : (Boolean(request.pause_reason) || request.requires_human || isPausedStatus);
  const isPaused = decisionRequired && !hasExecutionInFlight;

  const controlDisplay = getControlStateDisplay(control_state);
  const ControlStateIcon = controlDisplay.icon;
  const submittedAtDisplay = request.submitted_at || _threadMessages.find((m) => m.direction === "OUTBOUND")?.timestamp || null;
  const agentDecisions: AgentDecision[] = data.agent_decisions || [];
  const hasPortalHistory = !!request.last_portal_status && !portalTaskActive;

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* ── HEADER ─── 2 lines, max ~56px ──────────────────────────────────── */}
      <div className="shrink-0 border-b border-border/50 px-3 py-1.5">
        {/* Line 1: back + case identity + controls */}
        <div className="flex items-center gap-2 min-h-[28px]">
          <button
            onClick={() => router.push("/requests")}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs font-mono text-muted-foreground">#{request.id}</span>
          <span className="text-sm font-semibold truncate">{request.subject}</span>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1 py-0 shrink-0",
              isPausedStatus ? "border-amber-700/50 bg-amber-500/10 text-amber-300" : ""
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
              <DropdownMenuItem onClick={() => setSnoozeModalOpen(true)}><AlarmClock className="h-3.5 w-3.5 mr-1.5" />Snooze</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowCorrespondenceDialog(true)}><Phone className="h-3.5 w-3.5 mr-1.5" />Log Call</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowPasteInboundDialog(true)}><ClipboardPaste className="h-3.5 w-3.5 mr-1.5" />Paste Email</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setWithdrawDialogOpen(true)}><Ban className="h-3.5 w-3.5 mr-1.5" />Withdraw</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Line 2: metrics bar */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5">
          <span>{daysOpen(submittedAtDisplay)} open</span>
          <span className="text-border">|</span>
          <span>{formatCurrency(request.cost_amount) !== "—" ? formatCurrency(request.cost_amount) : "$0"}</span>
          {(request.next_due_at || request.statutory_due_at) && (
            <>
              <span className="text-border">|</span>
              <span className={cn(
                request.due_info?.is_overdue ? "text-red-400" : "text-muted-foreground"
              )}>
                {daysUntilDue(request.next_due_at || request.statutory_due_at) || "—"}
              </span>
            </>
          )}
          {liveRunLabel && (
            <>
              <span className="text-border">|</span>
              <span className="text-blue-400 flex items-center gap-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {liveRunLabel}
              </span>
            </>
          )}
          {portalTaskActive && !liveRunLabel && (
            <>
              <span className="text-border">|</span>
              <span className="text-blue-400 flex items-center gap-1">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                Portal submission
              </span>
            </>
          )}
          {/* Mismatch warning */}
          {(control_state === 'OUT_OF_SYNC' || control_mismatches.length > 0) && (
            <>
              <span className="text-border">|</span>
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
          {isAdmin && (liveRun?.trigger_run_id || activeWorkspaceRun?.trigger_run_id) && (
            <>
              <span className="text-border">|</span>
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
                <Thread messages={visibleThreadMessages} maxHeight="h-full" />
              </div>

              {/* Bottom action area (shrink-0, pinned at bottom) */}
              <div className="shrink-0 border-t border-border/50 max-h-[50%] overflow-y-auto">
                {pending_proposal ? (
                  <div className="px-3 py-3 space-y-2">
                    {/* Action type + confidence */}
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={cn("text-[10px] px-1 py-0", ACTION_TYPE_LABELS[pending_proposal.action_type]?.color || "")}>
                        {ACTION_TYPE_LABELS[pending_proposal.action_type]?.label || pending_proposal.action_type.replace(/_/g, " ")}
                      </Badge>
                      {typeof pending_proposal.confidence === "number" && (
                        <span className="text-[10px] text-muted-foreground">{Math.round(pending_proposal.confidence * 100)}%</span>
                      )}
                      {pendingDelivery && (
                        <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[200px]">
                          {pendingDelivery.method} → {pendingDelivery.target || "not set"}
                        </span>
                      )}
                    </div>

                    {/* Editable draft */}
                    {(pending_proposal.draft_body_text || pending_proposal.draft_subject) ? (
                      <div className="space-y-1.5">
                        {(pending_proposal.draft_subject || editedSubject) && (
                          <input
                            className="w-full bg-background border border-border/50 rounded px-2 py-1 text-xs font-[inherit]"
                            value={editedSubject}
                            onChange={(e) => setEditedSubject(e.target.value)}
                            placeholder="Subject"
                          />
                        )}
                        <textarea
                          className="w-full bg-background border border-border/50 rounded p-2 text-xs font-[inherit] leading-relaxed resize-y"
                          rows={8}
                          value={editedBody}
                          onChange={(e) => setEditedBody(e.target.value)}
                        />
                        {(editedBody !== (pending_proposal.draft_body_text || "") || editedSubject !== (pending_proposal.draft_subject || "")) && (
                          <button
                            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                            onClick={() => {
                              setEditedBody(pending_proposal.draft_body_text || "");
                              setEditedSubject(pending_proposal.draft_subject || "");
                            }}
                          >
                            <RotateCcw className="h-2.5 w-2.5" /> Reset to AI draft
                          </button>
                        )}
                        {/* Chain follow-up */}
                        {pending_proposal.action_chain && pending_proposal.action_chain.length > 1 && (
                          <div className="border-t border-dashed pt-2 mt-2 space-y-1.5">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-medium text-amber-400 uppercase tracking-wide flex items-center gap-1">
                                <ArrowRight className="h-2.5 w-2.5" /> Then: {ACTION_TYPE_LABELS[pending_proposal.action_chain[1].actionType]?.label || pending_proposal.action_chain[1].actionType}
                              </span>
                              {(() => {
                                const chainTarget = getDeliveryTarget(pending_proposal.action_chain[1].actionType, request, agency_summary || null);
                                return chainTarget ? (
                                  <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[200px]">
                                    {chainTarget.method} → {chainTarget.target || "not set"}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                            {pending_proposal.action_chain[1].draftSubject && (
                              <input
                                className="w-full bg-background border border-border/50 rounded px-2 py-1 text-xs"
                                value={editedChainSubject}
                                onChange={(e) => setEditedChainSubject(e.target.value)}
                                placeholder="Follow-up Subject"
                              />
                            )}
                            <textarea
                              className="w-full bg-background border border-border/50 rounded p-2 text-xs leading-relaxed resize-y"
                              rows={4}
                              value={editedChainBody}
                              onChange={(e) => setEditedChainBody(e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">No draft. Approve to continue processing.</p>
                    )}

                    {/* Reasoning (collapsible) */}
                    {Array.isArray(pending_proposal.reasoning) && pending_proposal.reasoning.length > 0 && (
                      <details className="text-xs">
                        <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">Reasoning</summary>
                        <ul className="mt-1 space-y-0.5 text-muted-foreground">
                          {formatReasoning(pending_proposal.reasoning, 5).map((r, i) => (
                            <li key={i} className="flex gap-1"><span className="text-blue-400 shrink-0">-</span><span>{r}</span></li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {/* Manual submit helper for SUBMIT_PORTAL */}
                    {pending_proposal.action_type === "SUBMIT_PORTAL" && portal_helper && (
                      <details className="text-xs">
                        <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-1">
                          <Globe className="h-2.5 w-2.5" /> Manual Submit Helper
                        </summary>
                        <div className="mt-1 space-y-2">
                          {portal_helper.portal_url && (
                            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => window.open(portal_helper.portal_url!, "_blank")}>
                              <ExternalLink className="h-2.5 w-2.5 mr-1" /> Open Portal
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => {
                            const lines = [
                              `Name: ${portal_helper.requester.name}`,
                              `Email: ${portal_helper.requester.email}`,
                              `Phone: ${portal_helper.requester.phone}`,
                              `Address: ${portal_helper.address.line1}, ${portal_helper.address.city}, ${portal_helper.address.state} ${portal_helper.address.zip}`,
                              portal_helper.case_info.subject_name && `Subject: ${portal_helper.case_info.subject_name}`,
                              portal_helper.case_info.incident_date && `Date: ${portal_helper.case_info.incident_date}`,
                              portal_helper.case_info.requested_records.length > 0 && `Records: ${portal_helper.case_info.requested_records.join(", ")}`,
                            ].filter(Boolean).join("\n");
                            navigator.clipboard.writeText(lines);
                            toast.success("Fields copied");
                          }}>
                            <Copy className="h-2.5 w-2.5 mr-1" /> Copy All Fields
                          </Button>
                          <Button
                            size="sm" variant="outline"
                            className="h-6 text-[10px] border-green-700/50 text-green-400"
                            onClick={handleManualSubmit}
                            disabled={isManualSubmitting}
                          >
                            {isManualSubmitting ? <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" /> : <CheckCircle className="h-2.5 w-2.5 mr-1" />}
                            Mark Submitted
                          </Button>
                        </div>
                      </details>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-1">
                      {(() => {
                        const gateOptions = pending_proposal.gate_options as string[] | null;
                        const showApprove = !gateOptions || gateOptions.includes("APPROVE");
                        const showAdjust = !gateOptions || gateOptions.includes("ADJUST");
                        const showDismiss = !gateOptions || gateOptions.includes("DISMISS");
                        const showRetryResearch = gateOptions?.includes("RETRY_RESEARCH");
                        return (
                          <>
                            {showRetryResearch && (
                              <Button size="sm" className="h-7 text-xs bg-amber-700 hover:bg-amber-600" onClick={handleRetryResearch} disabled={isApproving || isAdjustingPending}>
                                {isApproving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                                Retry Research
                              </Button>
                            )}
                            {showApprove && (
                              <Button size="sm" className="h-7 text-xs bg-green-700 hover:bg-green-600" onClick={handleApprovePending} disabled={isApproving || isAdjustingPending}>
                                {isApproving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : isEmailLikePendingAction ? <Send className="h-3 w-3 mr-1" /> : <CheckCircle className="h-3 w-3 mr-1" />}
                                {pendingApproveLabel}
                              </Button>
                            )}
                            {showAdjust && (
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPendingAdjustModalOpen(true)} disabled={isApproving || isAdjustingPending}>
                                <Edit className="h-3 w-3 mr-1" /> Adjust
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
                                    <DropdownMenuItem key={reason} onClick={() => handleDismissPending(reason)} className="text-xs">{reason}</DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ) : isPaused ? (
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
                      onAddToPhoneQueue={handleAddToPhoneQueue}
                      onResolveReview={handleResolveReview}
                      onRepair={handleResetToLastInbound}
                      isLoading={isApproving || isRevising || isResolving}
                    />
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
                <CaseInfoTab request={request} agencySummary={agency_summary} deadlineMilestones={deadline_milestones} stateDeadline={state_deadline} />
              </div>
            </ScrollArea>
          ) : (
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
                        placeholder="Agency name"
                        value={manualAgencyName}
                        onChange={(e) => setManualAgencyName(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <Input
                        placeholder="Email (optional)"
                        value={manualAgencyEmail}
                        onChange={(e) => setManualAgencyEmail(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <Input
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
                      return (
                        <div key={ca.id} className="rounded border p-3 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium">{ca.agency_name || "Unnamed"}</span>
                            {ca.is_primary && <Badge variant="secondary" className="text-[10px] px-1">Primary</Badge>}
                          </div>
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
                          {stats && stats.total > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              {stats.total} messages ({stats.outbound} sent, {stats.inbound} received)
                              {stats.lastMessageAt && <span> · Last: {formatRelativeTime(stats.lastMessageAt)}</span>}
                            </div>
                          )}
                          <div className="flex items-center gap-1.5 pt-1">
                            {!ca.is_primary && (
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleSetPrimaryAgency(ca.id)} disabled={agencyActionLoadingId === ca.id}>
                                {agencyActionLoadingId === ca.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Set Primary"}
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleResearchAgency(ca.id)} disabled={agencyActionLoadingId === ca.id}>
                              {agencyActionLoadingId === ca.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : "Research"}
                            </Button>
                            <Button size="sm" className="h-6 text-[10px]" onClick={() => handleStartRequestForAgency(ca.id)} disabled={agencyStartLoadingId === ca.id}>
                              {agencyStartLoadingId === ca.id ? <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" /> : <Play className="h-2.5 w-2.5 mr-1" />}
                              Start Request
                            </Button>
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
          )}
        </div>

        {/* ── RIGHT PANEL: Intel Sidebar (always visible) ─────────────────── */}
        <div className="w-[380px] shrink-0 flex flex-col min-h-0">
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
                  {(request.portal_url || agency_summary?.portal_url) && (
                    <div className="flex items-center gap-1 text-[10px]">
                      <Globe className="h-2.5 w-2.5 text-muted-foreground" />
                      <a
                        href={request.portal_url || agency_summary?.portal_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline truncate"
                      >
                        {request.portal_provider || agency_summary?.portal_provider || "Portal"}
                      </a>
                    </div>
                  )}
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
                </div>
              </CollapsibleSection>

              {/* SCOPE */}
              {request.scope_items && request.scope_items.length > 0 && (
                <CollapsibleSection title="SCOPE" count={request.scope_items.length}>
                  <ScopeSummary items={request.scope_items} />
                  <div className="mt-1.5 space-y-1">
                    {request.scope_items.map((item: any, idx: number) => {
                      const statusMap: Record<string, { label: string; color: string }> = {
                        CONFIRMED_AVAILABLE: { label: "Available", color: "text-green-400" },
                        NOT_DISCLOSABLE: { label: "Exempt", color: "text-red-400" },
                        NOT_HELD: { label: "Not Held", color: "text-orange-400" },
                        DELIVERED: { label: "Delivered", color: "text-emerald-400" },
                        DENIED: { label: "Denied", color: "text-red-400" },
                        PARTIAL: { label: "Partial", color: "text-yellow-400" },
                        EXEMPT: { label: "Exempt", color: "text-red-400" },
                      };
                      const s = statusMap[item.status] || { label: item.status || "Requested", color: "text-gray-500" };
                      return (
                        <div key={idx} className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate">{item.name}</span>
                          <span className={cn("shrink-0 text-[10px] font-medium", s.color)}>{s.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </CollapsibleSection>
              )}

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
              {request.constraints && request.constraints.length > 0 && (
                <CollapsibleSection title="CONSTRAINTS" count={request.constraints.length}>
                  <ConstraintsDisplay constraints={request.constraints} />
                </CollapsibleSection>
              )}

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
                  <Timeline events={timeline_events.slice(0, 12)} />
                </CollapsibleSection>
              )}

              {/* Portal history */}
              {hasPortalHistory && (
                <CollapsibleSection title="PORTAL HISTORY" defaultOpen={false}>
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
        <div className="flex items-center gap-0 px-3 h-8">
          {/* Main view tabs */}
          {(["thread", "case-info", "agency"] as const).map((tab) => (
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
            </button>
          ))}
          <span className="text-border mx-1">|</span>
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
              <div className="p-3 space-y-1">
                {agentDecisions.length > 0 ? agentDecisions.slice(0, 20).map((d) => (
                  <div key={d.id} className="flex items-start gap-2 text-[11px]">
                    <span className="text-muted-foreground shrink-0">{formatRelativeTime(d.created_at)}</span>
                    <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">{d.action_taken}</Badge>
                    <span className="text-muted-foreground truncate">{typeof d.reasoning === 'string' ? d.reasoning : Array.isArray(d.reasoning) ? d.reasoning[0] : "—"}</span>
                  </div>
                )) : (
                  <p className="text-xs text-muted-foreground">No agent decisions yet</p>
                )}
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
