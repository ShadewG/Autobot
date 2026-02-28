"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, Suspense, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
import { DueDisplay } from "@/components/due-display";
import { Timeline } from "@/components/timeline";
import { Thread } from "@/components/thread";
import { Composer } from "@/components/composer";
import { CopilotPanel } from "@/components/copilot-panel";
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
import { formatDate, cn, formatReasoning, ACTION_TYPE_LABELS } from "@/lib/utils";
import {
  ArrowLeft,
  Loader2,
  Calendar,
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

const DISMISS_REASONS = [
  "Wrong action",
  "Already handled",
  "Duplicate",
  "Bad timing",
  "Not needed",
];

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
    ESCALATE: "The system couldn't determine next steps. Review the reasoning and choose an action.",
  };
  let explanation = explanations[actionType] || `Will execute: ${actionType.replace(/_/g, " ").toLowerCase()}.`;
  if (!hasDraft && actionType.startsWith("SEND")) {
    explanation += " The AI will generate the draft before sending.";
  }
  if (actionType === "SUBMIT_PORTAL" && portalUrl) {
    explanation += ` Target: ${portalUrl}`;
  } else if (actionType.startsWith("SEND") && agencyEmail) {
    explanation += ` To: ${agencyEmail}`;
  }
  return explanation;
}

function getDeliveryTarget(
  actionType: string | null,
  request: RequestWorkspaceResponse["request"],
  agency: RequestWorkspaceResponse["agency_summary"] | null
): { method: string; target: string | null } | null {
  if (!actionType) return null;
  if (actionType === "SUBMIT_PORTAL") {
    return {
      method: "PORTAL",
      target: request.portal_url || agency?.portal_url || null,
    };
  }
  if (
    [
      "SEND_INITIAL_REQUEST",
      "SEND_FOLLOWUP",
      "SEND_CLARIFICATION",
      "SEND_REBUTTAL",
      "NEGOTIATE_FEE",
      "ACCEPT_FEE",
      "DECLINE_FEE",
      "SEND_PDF_EMAIL",
    ].includes(actionType)
  ) {
    return {
      method: "EMAIL",
      target: request.agency_email || null,
    };
  }
  return null;
}

// Gate icons and colors
const GATE_DISPLAY: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  FEE_QUOTE: {
    icon: <DollarSign className="h-4 w-4" />,
    color: "text-amber-400 bg-amber-500/10 border-amber-700/50",
    label: "Fee Quote",
  },
  DENIAL: {
    icon: <XCircle className="h-4 w-4" />,
    color: "text-red-400 bg-red-500/10 border-red-700/50",
    label: "Denial",
  },
  SCOPE: {
    icon: <FileQuestion className="h-4 w-4" />,
    color: "text-orange-400 bg-orange-500/10 border-orange-700/50",
    label: "Scope Issue",
  },
  ID_REQUIRED: {
    icon: <UserCheck className="h-4 w-4" />,
    color: "text-blue-400 bg-blue-500/10 border-blue-700/50",
    label: "ID Required",
  },
  SENSITIVE: {
    icon: <AlertTriangle className="h-4 w-4" />,
    color: "text-purple-400 bg-purple-500/10 border-purple-700/50",
    label: "Sensitive",
  },
  CLOSE_ACTION: {
    icon: <CheckCircle className="h-4 w-4" />,
    color: "text-green-400 bg-green-500/10 border-green-700/50",
    label: "Ready to Close",
  },
  INITIAL_REQUEST: {
    icon: <Send className="h-4 w-4" />,
    color: "text-blue-400 bg-blue-500/10 border-blue-700/50",
    label: "Pending Approval",
  },
  PENDING_APPROVAL: {
    icon: <Clock className="h-4 w-4" />,
    color: "text-blue-400 bg-blue-500/10 border-blue-700/50",
    label: "Pending Approval",
  },
};
const FALLBACK_GATE_DISPLAY = {
  icon: <AlertTriangle className="h-4 w-4" />,
  color: "text-yellow-400 bg-yellow-500/10 border-yellow-700/50",
  label: "Needs Review",
};

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
    const normalized = node.toLowerCase();
    const knownNodes: Record<string, string> = {
      load_context: "loading context",
      classify_inbound: "classifying inbound",
      decide_action: "deciding next action",
      research_context: "researching",
      draft_response: "generating draft",
      draft_initial_request: "generating initial request",
      create_proposal_gate: "creating proposal",
      wait_human_decision: "waiting for human decision",
      execute_action: "executing action",
      commit_state: "updating case state",
      schedule_followups: "scheduling follow-up",
      safety_check: "performing safety check",
      complete: "completed",
      failed: "failed"
    };
    action = knownNodes[normalized] || node.replace(/[_-]/g, " ");
  }
  if (status === "waiting") return "Paused: awaiting human decision";
  if (status === "queued" || status === "created") return `Queued: ${action}`;
  if (status === "running" || status === "processing") return `Running: ${action}`;
  return null;
}

function buildTriggerRunUrl(triggerRunId?: string | null): string | null {
  if (!triggerRunId) return null;
  return `https://cloud.trigger.dev/orgs/frontwind-llc-27ae/projects/autobot-Z-SQ/env/prod/runs/${triggerRunId}`;
}

function getControlStateDisplay(controlState?: string | null) {
  const key = String(controlState || "").toUpperCase();
  switch (key) {
    case "WORKING":
      return { label: "Working", className: "border-blue-700/50 bg-blue-500/10 text-blue-300", icon: Loader2 };
    case "NEEDS_DECISION":
      return { label: "Needs Your Decision", className: "border-amber-700/50 bg-amber-500/10 text-amber-300", icon: Clock };
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

function normalizeDecisionReasoning(reasoning: string | string[] | null | undefined): string {
  if (Array.isArray(reasoning)) {
    return reasoning.filter(Boolean).join("\n");
  }
  if (!reasoning) return "";
  const trimmed = String(reasoning).trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).join("\n");
      if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
    } catch {
      // fall through to raw string
    }
  }
  return trimmed;
}

function formatAgencyNotes(notes?: string | null): string | null {
  if (!notes) return null;
  const trimmed = String(notes).trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(parsed, null, 2);
  } catch (_) {
    return trimmed;
  }
}

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
  if (message.case_agency_id && Number(message.case_agency_id) === Number(agency.id)) {
    return true;
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

function RequestDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const id = searchParams.get("id");

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
  const [controlCenterOpen, setControlCenterOpen] = useState(false);
  const [isManualSubmitting, setIsManualSubmitting] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [agencyActionLoadingId, setAgencyActionLoadingId] = useState<number | null>(null);
  const [agencyStartLoadingId, setAgencyStartLoadingId] = useState<number | null>(null);
  const [candidateActionLoadingName, setCandidateActionLoadingName] = useState<string | null>(null);
  const [candidateStartLoadingName, setCandidateStartLoadingName] = useState<string | null>(null);
  const [manualAgencyName, setManualAgencyName] = useState("");
  const [manualAgencyEmail, setManualAgencyEmail] = useState("");
  const [manualAgencyPortalUrl, setManualAgencyPortalUrl] = useState("");
  const [isManualAgencySubmitting, setIsManualAgencySubmitting] = useState(false);
  const [conversationTab, setConversationTab] = useState<string>("all");
  const [optimisticMessages, setOptimisticMessages] = useState<Array<ThreadMessage & { _sending: true }>>([]);
  const [guideInstruction, setGuideInstruction] = useState("");
  const [isGuidingAI, setIsGuidingAI] = useState(false);
  const [isTakingOver, setIsTakingOver] = useState(false);

  const [pollingUntil, setPollingUntil] = useState<number>(0);
  const refreshInterval = Date.now() < pollingUntil ? 3000 : 0;

  const { data, error, isLoading, mutate } = useSWR<RequestWorkspaceResponse>(
    id ? `/requests/${id}/workspace` : null,
    fetcher,
    { refreshInterval }
  );

  // Set nextAction from data
  useEffect(() => {
    setNextAction(data?.next_action_proposal || null);
  }, [data?.next_action_proposal]);

  // Keep edited draft in sync when pending_proposal changes
  useEffect(() => {
    setEditedBody(data?.pending_proposal?.draft_body_text || "");
    setEditedSubject(data?.pending_proposal?.draft_subject || "");
  }, [data?.pending_proposal?.draft_body_text, data?.pending_proposal?.draft_subject]);

  // Get last inbound message
  const lastInboundMessage = useMemo(() => {
    if (!data?.thread_messages) return null;
    const inbound = data.thread_messages.filter(m => m.direction === "INBOUND");
    return inbound.length > 0 ? inbound[inbound.length - 1] : null;
  }, [data?.thread_messages]);

  const handleProceed = async (costCap?: number) => {
    if (!id) return;
    setIsApproving(true);
    try {
      const result = await requestsAPI.approve(id, nextAction?.id, costCap);
      setProposalState("QUEUED");
      const minDelay = 2 * 60 * 60 * 1000;
      const maxDelay = 10 * 60 * 60 * 1000;
      const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);
      const estimated = new Date(Date.now() + randomDelay);
      setScheduledSendAt(result?.scheduled_send_at || estimated.toISOString());
      optimisticClear();
    } finally {
      setIsApproving(false);
    }
  };

  const handleNegotiate = () => {
    handleRevise(
      "Draft a fee negotiation email proposing to narrow the scope to reduce cost. Focus on limiting to the primary responding and arresting officers only, and offering a tighter time window around the incident. If the agency already provided an itemized fee breakdown, acknowledge it and propose a specific narrowed scope using that info. Ask about public/media interest fee waivers under state statute. Do NOT suggest in-person viewing — we are a remote team."
    );
  };

  const handleCustomAdjust = () => {
    setAdjustModalOpen(true);
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
      console.error("Error withdrawing request:", error);
      alert("Failed to withdraw request. Please try again.");
    } finally {
      setIsResolving(false);
    }
  };

  const handleNarrowScope = () => {
    handleRevise(
      "Draft a response narrowing the scope of the request to address the agency's overbreadth objection. Remove or limit the specific items they flagged as too broad while preserving the core records we need. Propose a clear, focused scope."
    );
  };

  const handleAppeal = () => {
    handleRevise(
      "Draft an administrative appeal of the denial. Cite the applicable state public records statute and challenge the exemptions the agency cited. Request reconsideration with legal basis for why the exemptions should not apply here. Be firm but professional."
    );
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
      if (data.already_exists) {
        alert("This case is already in the phone call queue.");
      } else {
        alert("Added to phone call queue.");
      }
      mutate();
    } catch (error) {
      console.error("Error adding to phone queue:", error);
      alert("Failed to add to phone queue.");
    }
  };

  const handleResolveReview = async (action: string, instruction?: string) => {
    if (!id) return;
    setIsResolving(true);
    try {
      // For submit_manually, also open the portal URL
      if (action === "submit_manually" && data?.request?.portal_url) {
        window.open(data.request.portal_url, "_blank");
      }
      await requestsAPI.resolveReview(id, action, instruction);
      optimisticClear();
    } catch (error: any) {
      console.error("Error resolving review:", error);
      alert(error.message || "Failed to resolve review. Please try again.");
    } finally {
      setIsResolving(false);
    }
  };

  const handleApprovePending = async () => {
    if (!data?.pending_proposal) return;
    setIsApproving(true);
    try {
      const body: Record<string, unknown> = { action: "APPROVE" };
      // Include any edits the user made to the draft
      if (editedBody && editedBody !== (data.pending_proposal.draft_body_text || "")) body.draft_body_text = editedBody;
      if (editedSubject && editedSubject !== (data.pending_proposal.draft_subject || "")) body.draft_subject = editedSubject;

      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");

      // Add optimistic message for email-like actions
      const emailActions = ["SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_CLARIFICATION", "SEND_REBUTTAL", "NEGOTIATE_FEE", "ACCEPT_FEE", "DECLINE_FEE", "SEND_PDF_EMAIL"];
      const actionType = data.pending_proposal.action_type || "";
      if (emailActions.includes(actionType) && (editedBody || data.pending_proposal.draft_body_text)) {
        setOptimisticMessages(prev => [...prev, {
          id: -Date.now(),
          direction: 'OUTBOUND' as const,
          channel: 'EMAIL' as const,
          from_email: '',
          to_email: data.request.agency_email || '',
          subject: editedSubject || data.pending_proposal!.draft_subject || '',
          body: editedBody || data.pending_proposal!.draft_body_text || '',
          sent_at: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          attachments: [],
          _sending: true as const,
        }]);
        toast.success("Email sent");
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

  const copyField = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(key);
    setTimeout(() => setCopiedField(null), 1500);
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

  const handleSetPrimaryAgency = async (caseAgencyId: number) => {
    if (!id) return;
    setAgencyActionLoadingId(caseAgencyId);
    try {
      const res = await fetch(`/api/cases/${id}/agencies/${caseAgencyId}/set-primary`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed to set primary agency");
      mutate();
    } catch (e: any) {
      alert(e.message || "Failed to set primary agency");
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
      alert(e.message || "Failed to research agency");
    } finally {
      setAgencyActionLoadingId(null);
    }
  };

  const handleStartRequestForAgency = async (caseAgencyId: number) => {
    if (!id) return;
    const caseId = parseInt(id, 10);
    const caseAgency = data?.case_agencies?.find((ca) => Number(ca.id) === Number(caseAgencyId));
    if (!caseAgency) {
      alert("Agency not found on this case");
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
      alert(e.message || "Failed to start request for agency");
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
        await handleStartRequestForAgency(caseAgency.id);
      } else {
        mutate();
      }
    } catch (e: any) {
      alert(e.message || "Failed to add agency candidate");
    } finally {
      setCandidateActionLoadingName(null);
      setCandidateStartLoadingName(null);
    }
  };

  const handleAddManualAgency = async (startAfterAdd = false) => {
    if (!manualAgencyName.trim()) {
      alert("Agency name is required");
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
        await handleStartRequestForAgency(caseAgency.id);
      } else {
        mutate();
      }
    } catch (e: any) {
      alert(e.message || "Failed to add agency");
    } finally {
      setIsManualAgencySubmitting(false);
    }
  };

  const handleChallenge = (instruction: string) => {
    // Pre-fill the adjust modal with the challenge instruction
    setAdjustModalOpen(true);
  };

  const handleSnooze = async (snoozeUntil: string) => {
    if (!id) return;
    console.log("Snooze until:", snoozeUntil);
    mutate();
  };

  const [isRevising, setIsRevising] = useState(false);
  const [isInvokingAgent, setIsInvokingAgent] = useState(false);
  const [isGeneratingInitial, setIsGeneratingInitial] = useState(false);
  const [isRunningFollowup, setIsRunningFollowup] = useState(false);
  const [isResettingCase, setIsResettingCase] = useState(false);
  const [showInboundDialog, setShowInboundDialog] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [isRunningInbound, setIsRunningInbound] = useState(false);
  const [showPasteInboundDialog, setShowPasteInboundDialog] = useState(false);
  const [showCorrespondenceDialog, setShowCorrespondenceDialog] = useState(false);

  // Fetch agent runs for the Runs tab
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
        request: { ...cur.request, requires_human: false, pause_reason: null },
        pending_proposal: null,
        next_action_proposal: null,
        review_state: 'PROCESSING',
      } : cur,
      { revalidate: true }
    );
    mutateRuns();
    startPolling();
  }, [mutate, mutateRuns, startPolling]);

  const handleGenerateInitialRequest = async () => {
    if (!id) return;
    setIsGeneratingInitial(true);
    try {
      const result = await casesAPI.runInitial(parseInt(id), {
        autopilotMode: 'SUPERVISED',
      });
      if (result.success) {
        mutate(); // Refresh data
      } else {
        alert("Failed to generate initial request");
      }
    } catch (error: any) {
      console.error("Error generating initial request:", error);
      alert(error.message || "Failed to generate initial request");
    } finally {
      setIsGeneratingInitial(false);
    }
  };

  const handleInvokeAgent = async () => {
    if (!id) return;
    setIsInvokingAgent(true);
    try {
      const result = await requestsAPI.invokeAgent(id);
      if (result.success) {
        mutate(); // Refresh data
        mutateRuns();
      } else {
        alert(result.message || "Failed to invoke agent");
      }
    } catch (error: any) {
      console.error("Error invoking agent:", error);
      alert(error.message || "Failed to invoke agent");
    } finally {
      setIsInvokingAgent(false);
    }
  };

  const handleRunFollowup = async () => {
    if (!id) return;
    setIsRunningFollowup(true);
    try {
      const result = await casesAPI.runFollowup(parseInt(id), {
        autopilotMode: 'SUPERVISED',
      });
      if (result.success) {
        mutate();
        mutateRuns();
      } else {
        alert("Failed to trigger follow-up");
      }
    } catch (error: any) {
      console.error("Error triggering follow-up:", error);
      alert(error.message || "Failed to trigger follow-up");
    } finally {
      setIsRunningFollowup(false);
    }
  };

  const handleRunInbound = async (messageId: number) => {
    if (!id) return;
    setIsRunningInbound(true);
    try {
      const result = await casesAPI.runInbound(parseInt(id), messageId, {
        autopilotMode: 'SUPERVISED',
      });
      if (result.success) {
        mutate();
        mutateRuns();
        setShowInboundDialog(false);
        setSelectedMessageId(null);
      } else {
        alert("Failed to process inbound message");
      }
    } catch (error: any) {
      console.error("Error processing inbound message:", error);
      alert(error.message || "Failed to process inbound message");
    } finally {
      setIsRunningInbound(false);
    }
  };

  const handleResimulateLatestInbound = async () => {
    if (!id || !lastInboundMessage) return;
    setIsRunningInbound(true);
    try {
      const result = await casesAPI.runInbound(parseInt(id), lastInboundMessage.id, {
        autopilotMode: 'SUPERVISED',
      });
      if (result.success) {
        mutate();
        mutateRuns();
      } else {
        alert("Failed to resimulate inbound message");
      }
    } catch (error: any) {
      console.error("Error resimulating inbound message:", error);
      alert(error.message || "Failed to resimulate inbound message");
    } finally {
      setIsRunningInbound(false);
    }
  };

  const handleResetToLastInbound = async () => {
    if (!id) return;
    const ok = window.confirm(
      "Reset this case to the latest inbound message?\n\nThis will dismiss active proposals, clear in-flight run state, and reprocess from the latest inbound."
    );
    if (!ok) return;

    setIsResettingCase(true);
    try {
      const result = await requestsAPI.resetToLastInbound(id);
      if (result.success) {
        mutate();
        mutateRuns();
      } else {
        alert("Failed to reset case");
      }
    } catch (error: any) {
      console.error("Error resetting case:", error);
      alert(error.message || "Failed to reset case");
    } finally {
      setIsResettingCase(false);
    }
  };

  const handleTakeOverNow = async () => {
    if (!id) return;
    setIsTakingOver(true);
    try {
      await requestsAPI.update(id, {
        autopilot_mode: "MANUAL",
        requires_human: true,
      });
      mutate();
      mutateRuns();
      toast.success("Automation paused. Case switched to MANUAL mode.");
    } catch (error: any) {
      console.error("Error taking over case:", error);
      toast.error(error.message || "Failed to take over case");
    } finally {
      setIsTakingOver(false);
    }
  };

  const handleGuideAI = async () => {
    if (!id || !guideInstruction.trim()) return;
    setIsGuidingAI(true);
    try {
      let handled = false;
      try {
        const reviewResult = await requestsAPI.resolveReview(id, "custom", guideInstruction.trim());
        if (reviewResult?.success) handled = true;
      } catch {
        // Fallback below.
      }

      if (!handled && nextAction?.id) {
        const revised = await requestsAPI.revise(id, guideInstruction.trim(), nextAction.id);
        if (revised?.success !== false) handled = true;
      }

      if (!handled) {
        await requestsAPI.resetToLastInbound(id);
        handled = true;
      }

      if (handled) {
        setGuideInstruction("");
        mutate();
        mutateRuns();
        toast.success("Guidance submitted. AI is generating the next step.");
      }
    } catch (error: any) {
      console.error("Error guiding AI:", error);
      toast.error(error.message || "Failed to guide AI");
    } finally {
      setIsGuidingAI(false);
    }
  };

  // Get unprocessed inbound messages
  const unprocessedInboundMessages = useMemo(() => {
    if (!data?.thread_messages) return [];
    return data.thread_messages.filter(m =>
      m.direction === "INBOUND" && !m.processed_at
    );
  }, [data?.thread_messages]);
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
  const hasPortalHistory = useMemo(() => {
    return !!data?.request?.last_portal_status && !portalTaskActive;
  }, [data?.request?.last_portal_status, portalTaskActive]);
  const waitingRun = useMemo(() => {
    const list = runsData?.runs || [];
    return list.find((r) => String(r.status).toLowerCase() === "waiting") || null;
  }, [runsData?.runs]);
  const hasExecutionInFlight = useMemo(() => {
    const workspaceStatus = String(activeWorkspaceRun?.status || "").toLowerCase();
    return Boolean(
      liveRun ||
      portalTaskActive ||
      ["running", "queued", "created", "processing"].includes(workspaceStatus)
    );
  }, [liveRun, portalTaskActive, activeWorkspaceRun]);

  const handleRevise = async (instruction: string) => {
    if (!id) return;
    setIsRevising(true);
    try {
      const result = await requestsAPI.revise(id, instruction, nextAction?.id);
      if (result.next_action_proposal) {
        setNextAction(result.next_action_proposal);
      }
      setAdjustModalOpen(false);
      mutate(); // Refresh data
    } catch (error: any) {
      console.error("Error revising action:", error);
      alert(error.message || "Failed to revise action. There may not be a pending action to revise.");
    } finally {
      setIsRevising(false);
    }
  };

  const handleSendMessage = async (content: string) => {
    console.log("Send message:", content);
    mutate();
  };

  // Hooks that depend on data must be called unconditionally (before early returns).
  // Use safe defaults so they're no-ops when data hasn't loaded yet.
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

    const matchedMessageIds = new Set<number>();
    for (const agency of conversationAgencies) {
      const messageIds = new Set<number>();
      for (const message of _threadMessages) {
        if (messageMatchesAgency(message, agency)) {
          messageIds.add(message.id);
          matchedMessageIds.add(message.id);
        }
      }
      buckets.push({
        id: `agency-${agency.id}`,
        label: agency.agency_name || `Agency ${agency.id}`,
        count: messageIds.size,
        messageIds,
      });
    }

    const otherIds = new Set(
      _threadMessages.filter((m) => !matchedMessageIds.has(m.id)).map((m) => m.id)
    );
    if (otherIds.size > 0) {
      buckets.push({ id: "other", label: "Other", count: otherIds.size, messageIds: otherIds });
    }
    return buckets;
  }, [_threadMessages, conversationAgencies, shouldShowConversationTabs]);

  useEffect(() => {
    if (!conversationBuckets.some((bucket) => bucket.id === conversationTab)) {
      setConversationTab("all");
    }
  }, [conversationBuckets, conversationTab]);

  // Auto-clear optimistic messages when real messages arrive
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    setOptimisticMessages(prev => prev.filter(opt => {
      const hasReal = _threadMessages.some(m =>
        m.direction === 'OUTBOUND' &&
        m.id > 0 &&
        new Date(m.sent_at).getTime() >= new Date(opt.sent_at).getTime() - 5000
      );
      return !hasReal;
    }));
  }, [_threadMessages]);

  // Safety net: clear optimistic messages after 120s
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    const timer = setTimeout(() => setOptimisticMessages([]), 120_000);
    return () => clearTimeout(timer);
  }, [optimisticMessages.length]);

  // Auto-open Control Center when mismatches detected
  useEffect(() => {
    const mismatches = data?.control_mismatches || [];
    if (mismatches.length > 0 || data?.control_state === 'OUT_OF_SYNC') {
      setControlCenterOpen(true);
    }
  }, [data?.control_mismatches?.length, data?.control_state]);

  const visibleThreadMessages = useMemo(() => {
    const selected = conversationBuckets.find((bucket) => bucket.id === conversationTab);
    const real = (!selected || conversationTab === "all")
      ? _threadMessages
      : _threadMessages.filter((message) => selected.messageIds.has(message.id));
    return [...real, ...optimisticMessages];
  }, [_threadMessages, conversationBuckets, conversationTab, optimisticMessages]);

  if (!id) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">No request ID provided</p>
        <Link href="/requests" className="text-primary hover:underline mt-4 inline-block">
          Back to Requests
        </Link>
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
        <p className="text-sm text-muted-foreground">
          {error?.message || "Request not found"}
        </p>
        <Link href="/requests" className="text-primary hover:underline mt-4 inline-block">
          Back to Requests
        </Link>
      </div>
    );
  }

  const {
    request,
    timeline_events,
    thread_messages,
    agency_summary,
    deadline_milestones,
    state_deadline,
    pending_proposal,
    portal_helper,
    review_state,
    control_state,
    control_mismatches = [],
    active_run,
    case_agencies = [],
    agency_candidates = [],
  } = data;
  const pendingAgencyCandidatesCount = agency_candidates.length;

  const pendingActionType = pending_proposal?.action_type || "";
  const isEmailLikePendingAction = [
    "SEND_INITIAL_REQUEST",
    "SEND_FOLLOWUP",
    "SEND_CLARIFICATION",
    "SEND_REBUTTAL",
    "NEGOTIATE_FEE",
    "ACCEPT_FEE",
    "DECLINE_FEE",
    "SEND_PDF_EMAIL",
  ].includes(pendingActionType);
  const pendingCardTitle = isEmailLikePendingAction
    ? "Draft Pending Approval"
    : "Proposal Pending Approval";
  const pendingApproveLabel = isEmailLikePendingAction ? "Send" : "Approve";
  const pendingDelivery = getDeliveryTarget(pendingActionType || null, request, agency_summary || null);
  const nextDelivery = pendingDelivery
    ? pendingDelivery
    : nextAction?.channel
      ? {
          method: nextAction.channel,
          target:
            nextAction.channel === "PORTAL"
              ? (request.portal_url || agency_summary?.portal_url || null)
              : (nextAction.recipient_email || request.agency_email || null),
        }
      : null;

  const statusValue = String(request.status || "").toUpperCase();
  const isPausedStatus = statusValue === "NEEDS_HUMAN_REVIEW" || statusValue === "PAUSED";
  const statusDisplay = isPausedStatus ? "PAUSED" : (request.status || "—");
  const pauseReasonValue = String(request.pause_reason || "").toUpperCase();
  const shouldHidePauseReason =
    !request.pause_reason ||
    (pauseReasonValue === "PENDING_APPROVAL" && Boolean(waitingRun));

  const decisionRequired = review_state
    ? review_state === "DECISION_REQUIRED"
    : (Boolean(request.pause_reason) ||
      request.requires_human ||
      request.status?.toUpperCase() === "PAUSED" ||
      request.status?.toUpperCase() === "NEEDS_HUMAN_REVIEW" ||
      request.status?.toLowerCase().includes("needs_human"));
  // Guardrail: never show decision-required UI while execution is actively running.
  const isPaused = decisionRequired && !hasExecutionInFlight;
  const isDecisionApplying = review_state === 'DECISION_APPLYING';
  const nextExpectedEvent = (() => {
    if (hasExecutionInFlight) {
      if (portalTaskActive) return "Portal automation in progress";
      const node = liveRun?.current_node || activeWorkspaceRun?.current_node;
      return node ? `Processing: ${String(node).replace(/_/g, " ")}` : "Processing active run";
    }
    if (isPaused) return "Waiting for your decision";
    if (String(request.status || "").toUpperCase() === "AWAITING_RESPONSE") return "Waiting for agency reply";
    if (String(request.status || "").toUpperCase() === "RECEIVED_RESPONSE") return "Inbound received, awaiting processing";
    return "Idle";
  })();

  const gateDisplay = request.pause_reason
    ? (GATE_DISPLAY[request.pause_reason] || FALLBACK_GATE_DISPLAY)
    : null;

  // Build pause context string
  const getPauseContext = () => {
    if (!request.pause_reason) return null;

    if (request.pause_reason === "FEE_QUOTE") {
      const parts = [];
      if (request.cost_amount) parts.push(`$${request.cost_amount.toLocaleString()} estimate`);
      if (request.fee_quote?.deposit_amount) parts.push(`$${request.fee_quote.deposit_amount} deposit`);
      return parts.length > 0 ? parts.join(", ") : null;
    }

    return null;
  };

  const pauseContext = getPauseContext();
  const controlDisplay = getControlStateDisplay(control_state);
  const ControlStateIcon = controlDisplay.icon;
  const hasAgencyDetailLink = Boolean(agency_summary?.id && /^\d+$/.test(String(agency_summary.id)));
  const submittedAtDisplay = request.submitted_at || thread_messages.find((m) => m.direction === "OUTBOUND")?.timestamp || null;
  const lastInboundAtDisplay = request.last_inbound_at || lastInboundMessage?.timestamp || null;
  const agentDecisions: AgentDecision[] = data.agent_decisions || [];

  return (
    <div className="space-y-4">
      {/* Compact Header */}
      <div className="sticky top-10 z-30 bg-background border-b pb-3 -mx-6 px-6 pt-2">
        {/* Back + Title row */}
        <div className="flex items-center gap-4 mb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/requests")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold truncate">
              Request #{request.id} — {request.subject}
            </h1>
            <p className="text-sm text-muted-foreground">{request.agency_name}</p>
          </div>

          {/* Run Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={isInvokingAgent || isGeneratingInitial || isRunningFollowup || isRunningInbound || isResettingCase}
              >
                {(isInvokingAgent || isGeneratingInitial || isRunningFollowup || isRunningInbound || isResettingCase) ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-1" />
                )}
                Run
                <ChevronDown className="h-3 w-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleGenerateInitialRequest}>
                <Send className="h-4 w-4 mr-2" />
                Run Initial
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setShowInboundDialog(true)}
                disabled={unprocessedInboundMessages.length === 0}
              >
                <Inbox className="h-4 w-4 mr-2" />
                Run Inbound
                {unprocessedInboundMessages.length > 0 && (
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {unprocessedInboundMessages.length}
                  </Badge>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleResimulateLatestInbound}
                disabled={!lastInboundMessage}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Resimulate Latest Inbound
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleRunFollowup}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Run Follow-up
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleResetToLastInbound} disabled={!lastInboundMessage || isResettingCase}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Reset + Reprocess Latest Inbound
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleInvokeAgent}>
                <Bot className="h-4 w-4 mr-2" />
                Re-process Case
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* See in Notion button */}
          {request.notion_url && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(request.notion_url!, "_blank")}
            >
              <ExternalLink className="h-4 w-4 mr-1" />
              See in Notion
            </Button>
          )}

          {/* Overflow menu - always visible */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSnoozeModalOpen(true)}>
                <AlarmClock className="h-4 w-4 mr-2" />
                Snooze / Remind me
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setWithdrawDialogOpen(true)}>
                <Ban className="h-4 w-4 mr-2" />
                Withdraw request
              </DropdownMenuItem>
              <DropdownMenuItem>
                <CheckCircle className="h-4 w-4 mr-2" />
                Mark complete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Gate status - prominent when paused */}
        {isPaused && gateDisplay && (
          <div className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-md border mb-2",
            gateDisplay.color
          )}>
            {gateDisplay.icon}
            <span className="font-semibold">
              Paused: {gateDisplay.label}
              {pauseContext && <span className="font-normal"> — {pauseContext}</span>}
            </span>
          </div>
        )}

        {/* Draft Case CTA - prominent for cases not yet sent */}
        {(request.status === 'DRAFT' || request.status === 'READY_TO_SEND') && !request.submitted_at && (
          <div className="flex items-center gap-3 px-3 py-3 border border-blue-700/50 bg-blue-500/10 mb-2">
            <Send className="h-5 w-5 text-blue-400" />
            <div className="flex-1">
              <span className="font-semibold text-blue-300">Ready to Submit</span>
              <p className="text-xs text-blue-400">Generate and review the initial FOIA request for this case</p>
            </div>
            <Button
              onClick={handleGenerateInitialRequest}
              disabled={isGeneratingInitial}
              className="bg-blue-600 hover:bg-blue-500"
            >
              {isGeneratingInitial ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Generate Initial Request
                </>
              )}
            </Button>
          </div>
        )}

        {/* Case Status Panel */}
        <div className="flex items-center gap-4 text-xs mb-2">
          <div className="flex items-center gap-1.5 rounded border border-muted bg-muted/20 px-2 py-1">
            <span className="text-muted-foreground">Next:</span>
            <span className="font-medium">{nextExpectedEvent}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Status:</span>
            <Badge variant="outline" className="font-medium">
              {statusDisplay}
            </Badge>
          </div>
          {nextDelivery && (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-muted-foreground">Next delivery:</span>
              <Badge variant="outline" className="font-medium">
                {nextDelivery.method}
              </Badge>
              <span className="truncate max-w-[280px]" title={nextDelivery.target || "Destination not set yet"}>
                {nextDelivery.target || "Destination not set yet"}
              </span>
            </div>
          )}
          {request.requires_human && !isPausedStatus && !hasExecutionInFlight && (
            <div className="flex items-center gap-1.5">
              <UserCheck className="h-3 w-3 text-amber-500" />
              <span className="text-amber-400 font-medium">Requires Human</span>
            </div>
          )}
          {request.portal_request_number && (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-muted-foreground">NR:</span>
              <Badge variant="outline" className="font-medium truncate max-w-[120px]" title={request.portal_request_number}>
                {request.portal_request_number}
              </Badge>
            </div>
          )}
          {isAdmin && request.last_portal_task_url && (
            <a
              href={request.last_portal_task_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-orange-400 hover:underline text-xs"
            >
              <ExternalLink className="h-3 w-3" /> Skyvern Run
            </a>
          )}
          {isAdmin && (liveRun?.trigger_run_id || activeWorkspaceRun?.trigger_run_id) && (
            <a
              href={buildTriggerRunUrl(liveRun?.trigger_run_id || activeWorkspaceRun?.trigger_run_id) || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-blue-400 hover:underline text-xs"
            >
              <ExternalLink className="h-3 w-3" /> Trigger Run
            </a>
          )}
          {request.last_portal_status && (
            <Badge variant="outline" className="text-[10px] text-red-400 border-red-700/50">
              {request.last_portal_status}
            </Badge>
          )}
          {!shouldHidePauseReason && !(isPaused && gateDisplay) && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Pause Reason:</span>
              <Badge variant="outline" className="font-medium text-amber-400">
                {request.pause_reason}
              </Badge>
            </div>
          )}
          {/* Safety Hints */}
          <SafetyHints
            lastInboundProcessed={lastInboundMessage?.processed_at !== undefined && lastInboundMessage?.processed_at !== null}
            lastInboundProcessedAt={lastInboundMessage?.processed_at || undefined}
            hasActiveRun={
              (runsData?.runs?.some(r => ['running', 'queued', 'created', 'processing'].includes(r.status)) || false) ||
              portalTaskActive
            }
          />
          {liveRunLabel ? (
            <div className="flex items-center gap-1.5 rounded border border-blue-700/50 bg-blue-500/10 px-2 py-1">
              <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
              <span className="text-xs font-medium text-blue-300">{liveRunLabel}</span>
            </div>
          ) : portalTaskActive ? (
            <div className="flex items-center gap-1.5 rounded border border-blue-700/50 bg-blue-500/10 px-2 py-1">
              <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
              <span className="text-xs font-medium text-blue-300">Running: processing portal submission</span>
            </div>
          ) : waitingRun ? (
            <div className="flex items-center gap-1.5 rounded border border-amber-700/50 bg-amber-500/10 px-2 py-1">
              <Clock className="h-3 w-3 text-amber-400" />
              <span className="text-xs font-medium text-amber-300">Paused: awaiting human decision</span>
            </div>
          ) : isPaused ? (
            <div className="flex items-center gap-1.5 rounded border border-amber-700/50 bg-amber-500/10 px-2 py-1">
              <Clock className="h-3 w-3 text-amber-400" />
              <span className="text-xs text-amber-300">Paused: decision required</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 rounded border border-muted bg-muted/20 px-2 py-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Idle: no active run</span>
            </div>
          )}
        </div>

        {/* Case Control Center — collapsible */}
        {(() => {
          const needsRepair = control_state === 'OUT_OF_SYNC' || control_mismatches.length > 0;
          return (
            <div className="border rounded-md mb-2">
              {/* Collapsed header bar — always visible */}
              <button
                type="button"
                className="flex items-center justify-between w-full px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                onClick={() => setControlCenterOpen((v) => !v)}
              >
                <div className="flex items-center gap-2">
                  {controlCenterOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Case Control Center</span>
                  <div className={cn("flex items-center gap-1.5 rounded border px-2 py-0.5", controlDisplay.className)}>
                    <ControlStateIcon className={cn("h-3 w-3", control_state === "WORKING" && "animate-spin")} />
                    <span className="text-xs font-medium">{controlDisplay.label}</span>
                  </div>
                  {needsRepair && (
                    <div className="flex items-center gap-1 rounded border border-red-700/50 bg-red-500/10 px-2 py-0.5">
                      <AlertTriangle className="h-3 w-3 text-red-400" />
                      <span className="text-[10px] font-medium text-red-300">Needs repair</span>
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">Mode: {request.autopilot_mode || "SUPERVISED"}</span>
              </button>

              {/* Expanded content */}
              {controlCenterOpen && (
                <div className="px-3 pb-3 pt-1 space-y-3 border-t">
                  <div className={cn("grid grid-cols-1 gap-3", !pending_proposal && needsRepair ? "md:grid-cols-3" : !pending_proposal || needsRepair ? "md:grid-cols-2" : "")}>
                    {/* Automation Policy — always shown */}
                    <div className="space-y-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Automation Policy</p>
                      <AutopilotSelector
                        requestId={request.id}
                        currentMode={request.autopilot_mode}
                        onModeChange={() => mutate()}
                        compact
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={handleTakeOverNow}
                        disabled={isTakingOver}
                      >
                        {isTakingOver ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5 mr-1.5" />}
                        Take Over Now
                      </Button>
                    </div>

                    {/* Guide AI — hidden when proposal exists */}
                    {!pending_proposal && (
                      <div className="space-y-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Guide AI</p>
                        <textarea
                          className="w-full bg-background border rounded p-2 text-xs font-[inherit] leading-relaxed resize-y min-h-[76px]"
                          value={guideInstruction}
                          onChange={(e) => setGuideInstruction(e.target.value)}
                          placeholder="Tell AI exactly what to do next..."
                        />
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={handleGuideAI}
                          disabled={isGuidingAI || !guideInstruction.trim()}
                        >
                          {isGuidingAI ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Bot className="h-3.5 w-3.5 mr-1.5" />}
                          Run With Guidance
                        </Button>
                      </div>
                    )}

                    {/* Recovery — only shown when needed */}
                    {needsRepair && (
                      <div className="space-y-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Recovery</p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={handleResetToLastInbound}
                          disabled={!lastInboundMessage || isResettingCase}
                        >
                          {isResettingCase ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                          Fix Automatically
                        </Button>
                        <p className="text-[11px] text-muted-foreground">
                          Rebuilds run/proposal state from the latest inbound message when the case drifts.
                        </p>
                      </div>
                    )}
                  </div>

                  {control_mismatches.length > 0 && (
                    <div className="rounded border border-red-700/50 bg-red-500/10 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wide text-red-300 mb-1">State mismatch detected</p>
                      <ul className="text-xs text-red-200 space-y-0.5">
                        {control_mismatches.map((issue) => (
                          <li key={issue.code}>- {issue.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Status after approval */}
        {proposalState !== "PENDING" && (
          <div className="mb-2">
            <ProposalStatus
              state={proposalState}
              scheduledFor={scheduledSendAt}
            />
          </div>
        )}

        {/* Dates row - compact */}
        <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            <span>Submitted: {formatDate(submittedAtDisplay)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span>Last Inbound: {formatDate(lastInboundAtDisplay)}</span>
          </div>
          <Separator orientation="vertical" className="h-3" />
          <DueDisplay
            dueInfo={request.due_info}
            nextDueAt={request.next_due_at}
            statutoryDueAt={request.statutory_due_at}
          />
        </div>

        {isAdmin && (
          <div className="mt-2 flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Admin Debug:</span>
            {activeWorkspaceRun?.id && (
              <span>
                Active run #{activeWorkspaceRun.id} ({activeWorkspaceRun.status})
              </span>
            )}
            {activeWorkspaceRun?.current_node && (
              <span>Node: {String(activeWorkspaceRun.current_node)}</span>
            )}
            {activeWorkspaceRun?.trigger_run_id && (
              <a
                href={buildTriggerRunUrl(activeWorkspaceRun.trigger_run_id) || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                Open Trigger.dev
              </a>
            )}
            {(activeWorkspaceRun?.skyvern_task_url || request.last_portal_task_url) && (
              <a
                href={activeWorkspaceRun?.skyvern_task_url || request.last_portal_task_url || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-orange-400 hover:underline"
              >
                Open Skyvern
              </a>
            )}
          </div>
        )}
      </div>

      {/* Main Content - Different layout for paused vs not paused */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="case-info">Case Info</TabsTrigger>
          <TabsTrigger value="runs" className="flex items-center gap-1">
            <Activity className="h-3 w-3" />
            Runs
            {runsData?.runs && runsData.runs.length > 0 && (
              <Badge variant="secondary" className="text-xs px-1.5">
                {runsData.runs.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="agent-log">Agent Log</TabsTrigger>
          <TabsTrigger value="agency">Agency</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          {isPaused ? (
            /* Paused Layout: Conversation | Timeline | Decision Panel */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-4 items-start">
              {/* Conversation - takes most space, user needs to read this first */}
              <div className="md:col-span-2 lg:col-span-5 min-w-0">
                <Card className="h-full">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        Conversation
                      </CardTitle>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setShowCorrespondenceDialog(true)}
                        >
                          <Phone className="h-3 w-3 mr-1" />
                          Log Call
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setShowPasteInboundDialog(true)}
                        >
                          <ClipboardPaste className="h-3 w-3 mr-1" />
                          Paste Email
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!shouldShowConversationTabs && pendingAgencyCandidatesCount > 0 && (
                      <div className="rounded border border-amber-700/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                        {pendingAgencyCandidatesCount} suggested agenc{pendingAgencyCandidatesCount === 1 ? "y" : "ies"} not yet added to case.
                        Add them in the <span className="font-medium">Agency</span> tab to split conversation by agency.
                      </div>
                    )}
                    {shouldShowConversationTabs && (
                      <ScrollArea className="w-full whitespace-nowrap">
                        <div className="flex items-center gap-1 pb-1">
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
                    )}
                    <Thread messages={visibleThreadMessages} />
                    <Separator />
                    <Composer onSend={handleSendMessage} />
                  </CardContent>
                </Card>
              </div>

              {/* Timeline - middle */}
              <div className="md:col-span-1 lg:col-span-3 min-w-0">
                <Card className="h-full">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span>Timeline</span>
                      {state_deadline && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {state_deadline.state_code} - {state_deadline.response_days} business days
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Deadline Progress (compact) */}
                    {deadline_milestones && deadline_milestones.length > 0 && (
                      <DeadlineCalculator
                        milestones={deadline_milestones}
                        stateDeadline={state_deadline}
                        compact
                      />
                    )}
                    {deadline_milestones && deadline_milestones.length > 0 && <Separator />}
                    {/* Activity Timeline */}
                    <Timeline events={timeline_events} />
                  </CardContent>
                </Card>
              </div>

              {/* Decision Panel - sticky on right */}
              <div className="md:col-span-1 lg:col-span-4 min-w-0">
                <div className="sticky top-44 space-y-4">
                  {portalTaskActive && (
                    <PortalLiveView
                      caseId={id!}
                      initialScreenshotUrl={request.last_portal_screenshot_url}
                      portalTaskUrl={request.last_portal_task_url}
                    />
                  )}
                  {hasPortalHistory && (
                    <PortalLiveView
                      caseId={id!}
                      portalTaskUrl={request.last_portal_task_url}
                      isLive={false}
                    />
                  )}
                  {pending_proposal ? (
                    <Card className="border-2 border-blue-700/50 bg-blue-500/5">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2 text-blue-300">
                          {isEmailLikePendingAction ? <Send className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                          {pendingCardTitle}
                          {typeof pending_proposal.confidence === "number" && (
                            <Badge variant="outline" className="text-[10px]">
                              {Math.round(pending_proposal.confidence * 100)}%
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px] ml-auto">
                            {ACTION_TYPE_LABELS[pending_proposal.action_type]?.label || pending_proposal.action_type.replace(/_/g, " ")}
                          </Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {/* Draft content — editable */}
                        {(pending_proposal.draft_body_text || pending_proposal.draft_subject) ? (
                          <div className="border rounded p-3 space-y-2">
                            {pendingDelivery && (
                              <div className="rounded border bg-muted/30 px-2 py-1.5 text-[11px]">
                                <span className="font-medium">Destination:</span>{" "}
                                {pendingDelivery.method}{" "}
                                {pendingDelivery.target ? (
                                  <span className="text-muted-foreground">→ {pendingDelivery.target}</span>
                                ) : (
                                  <span className="text-amber-400">→ not set</span>
                                )}
                              </div>
                            )}
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                                {pending_proposal.action_type === "SUBMIT_PORTAL" ? "Portal Submission Text" : "Draft Email"}
                                <span className="ml-2 text-[10px] text-muted-foreground font-normal normal-case">edit inline before approving</span>
                              </span>
                              {(editedBody !== (pending_proposal.draft_body_text || "") || editedSubject !== (pending_proposal.draft_subject || "")) && (
                                <button
                                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                                  onClick={() => {
                                    setEditedBody(pending_proposal.draft_body_text || "");
                                    setEditedSubject(pending_proposal.draft_subject || "");
                                  }}
                                >
                                  <RotateCcw className="h-3 w-3" /> Reset to AI Draft
                                </button>
                              )}
                            </div>
                            {(pending_proposal.draft_subject || editedSubject) && (
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
                            />
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No outbound message draft for this action. Approve to continue processing this proposal.
                          </p>
                        )}
                        {/* Manual Submit Helper — only for SUBMIT_PORTAL */}
                        {pending_proposal.action_type === "SUBMIT_PORTAL" && portal_helper && (
                          <div className="border rounded">
                            <button
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                              onClick={() => setManualSubmitOpen(!manualSubmitOpen)}
                            >
                              <ChevronRight className={cn("h-3 w-3 transition-transform", manualSubmitOpen && "rotate-90")} />
                              Manual Submit Helper
                            </button>
                            {manualSubmitOpen && (
                              <div className="px-3 pb-3 space-y-3">
                                {portal_helper.portal_url && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="w-full"
                                    onClick={() => window.open(portal_helper.portal_url!, "_blank")}
                                  >
                                    <ExternalLink className="h-3 w-3 mr-1.5" /> Open Portal
                                  </Button>
                                )}

                                {/* Requester Info */}
                                <div>
                                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Requester</p>
                                  <div className="space-y-0.5">
                                    {([
                                      ["Name", portal_helper.requester.name],
                                      ["Email", portal_helper.requester.email],
                                      ["Phone", portal_helper.requester.phone],
                                      ["Organization", portal_helper.requester.organization],
                                      ["Title", portal_helper.requester.title],
                                    ] as const).map(([label, val]) => (
                                      <div key={label} className="flex items-center gap-2 text-xs group">
                                        <span className="text-muted-foreground w-20 shrink-0">{label}</span>
                                        <span className="flex-1 truncate">{val}</span>
                                        <button
                                          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                                          onClick={() => copyField(label, val)}
                                          title={`Copy ${label}`}
                                        >
                                          {copiedField === label ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* Address */}
                                <div>
                                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Address</p>
                                  <div className="space-y-0.5">
                                    {([
                                      ["Street", portal_helper.address.line1],
                                      ["Apt/Suite", portal_helper.address.line2],
                                      ["City", portal_helper.address.city],
                                      ["State", portal_helper.address.state],
                                      ["Zip", portal_helper.address.zip],
                                    ] as const).map(([label, val]) => (
                                      <div key={label} className="flex items-center gap-2 text-xs group">
                                        <span className="text-muted-foreground w-20 shrink-0">{label}</span>
                                        <span className="flex-1 truncate">{val}</span>
                                        <button
                                          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                                          onClick={() => copyField(`addr-${label}`, val)}
                                          title={`Copy ${label}`}
                                        >
                                          {copiedField === `addr-${label}` ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* Request Details */}
                                <div>
                                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Request Details</p>
                                  <div className="space-y-0.5">
                                    {portal_helper.case_info.subject_name && (
                                      <div className="flex items-center gap-2 text-xs group">
                                        <span className="text-muted-foreground w-20 shrink-0">Subject</span>
                                        <span className="flex-1 truncate">{portal_helper.case_info.subject_name}</span>
                                        <button className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" onClick={() => copyField("subject", portal_helper.case_info.subject_name!)}>
                                          {copiedField === "subject" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                        </button>
                                      </div>
                                    )}
                                    {portal_helper.case_info.incident_date && (
                                      <div className="flex items-center gap-2 text-xs group">
                                        <span className="text-muted-foreground w-20 shrink-0">Date</span>
                                        <span className="flex-1 truncate">{portal_helper.case_info.incident_date}</span>
                                        <button className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" onClick={() => copyField("date", portal_helper.case_info.incident_date!)}>
                                          {copiedField === "date" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                        </button>
                                      </div>
                                    )}
                                    {portal_helper.case_info.incident_location && (
                                      <div className="flex items-center gap-2 text-xs group">
                                        <span className="text-muted-foreground w-20 shrink-0">Location</span>
                                        <span className="flex-1 truncate">{portal_helper.case_info.incident_location}</span>
                                        <button className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" onClick={() => copyField("location", portal_helper.case_info.incident_location!)}>
                                          {copiedField === "location" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                        </button>
                                      </div>
                                    )}
                                    {portal_helper.case_info.requested_records.length > 0 && (
                                      <div className="text-xs">
                                        <div className="flex items-center gap-2 group">
                                          <span className="text-muted-foreground w-20 shrink-0">Records</span>
                                          <span className="flex-1 truncate">{portal_helper.case_info.requested_records.length} type(s)</span>
                                          <button
                                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                                            onClick={() => copyField("records", portal_helper.case_info.requested_records.join("\n"))}
                                            title="Copy all records"
                                          >
                                            {copiedField === "records" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                          </button>
                                        </div>
                                        <div className="ml-[88px] mt-0.5 space-y-0.5">
                                          {portal_helper.case_info.requested_records.map((rec, i) => (
                                            <div key={i} className="flex items-center gap-1.5 group/rec">
                                              <span className="text-muted-foreground">-</span>
                                              <span className="flex-1 truncate">{rec}</span>
                                              <button
                                                className="opacity-0 group-hover/rec:opacity-100 transition-opacity p-0.5"
                                                onClick={() => copyField(`rec-${i}`, rec)}
                                              >
                                                {copiedField === `rec-${i}` ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                              </button>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {portal_helper.case_info.additional_details && (
                                      <div className="text-xs">
                                        <div className="flex items-center gap-2 group">
                                          <span className="text-muted-foreground w-20 shrink-0">Details</span>
                                          <span className="flex-1 truncate">{portal_helper.case_info.additional_details.slice(0, 60)}...</span>
                                          <button className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" onClick={() => copyField("details", portal_helper.case_info.additional_details!)}>
                                            {copiedField === "details" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                    <div className="flex items-center gap-2 text-xs group">
                                      <span className="text-muted-foreground w-20 shrink-0">Fee Waiver</span>
                                      <span className="flex-1 truncate">{portal_helper.fee_waiver_reason}</span>
                                      <button className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" onClick={() => copyField("fee", portal_helper.fee_waiver_reason)}>
                                        {copiedField === "fee" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                      </button>
                                    </div>
                                    <div className="flex items-center gap-2 text-xs group">
                                      <span className="text-muted-foreground w-20 shrink-0">Delivery</span>
                                      <span className="flex-1 truncate">{portal_helper.preferred_delivery}</span>
                                      <button className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" onClick={() => copyField("delivery", portal_helper.preferred_delivery)}>
                                        {copiedField === "delivery" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
                                      </button>
                                    </div>
                                  </div>
                                </div>

                                <Separator />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="w-full border-green-700/50 text-green-400 hover:bg-green-700/20"
                                  onClick={handleManualSubmit}
                                  disabled={isManualSubmitting}
                                >
                                  {isManualSubmitting ? (
                                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                                  ) : (
                                    <CheckCircle className="h-3 w-3 mr-1.5" />
                                  )}
                                  Mark as Manually Submitted
                                </Button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Reasoning */}
                        {Array.isArray(pending_proposal.reasoning) && pending_proposal.reasoning.length > 0 && (
                          <ul className="text-xs text-muted-foreground space-y-1">
                            {formatReasoning(pending_proposal.reasoning, 5).map((r, i) => (
                              <li key={i} className="flex gap-1.5">
                                <span className="text-blue-400 shrink-0">•</span>
                                <span>{r}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {/* Action explanation */}
                        <p className="text-[10px] text-muted-foreground">
                          {getActionExplanation(
                            pending_proposal.action_type,
                            !!(pending_proposal.draft_body_text),
                            agency_summary?.portal_url,
                            request.agency_email
                          )}
                        </p>
                        {/* Action buttons */}
                        <div className="space-y-2 pt-1">
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="flex-1 bg-green-700 hover:bg-green-600 text-white"
                              onClick={handleApprovePending}
                              disabled={isApproving || isAdjustingPending}
                            >
                              {isApproving ? (
                                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                              ) : isEmailLikePendingAction ? (
                                <Send className="h-3 w-3 mr-1.5" />
                              ) : (
                                <CheckCircle className="h-3 w-3 mr-1.5" />
                              )}
                              {pendingApproveLabel}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setPendingAdjustModalOpen(true)}
                              disabled={isApproving || isAdjustingPending}
                            >
                              <Edit className="h-3 w-3 mr-1" /> Adjust
                            </Button>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full"
                                disabled={isApproving || isAdjustingPending}
                              >
                                <Trash2 className="h-3 w-3 mr-1" /> Dismiss
                                <ChevronDown className="h-3 w-3 ml-1" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              {DISMISS_REASONS.map((reason) => (
                                <DropdownMenuItem
                                  key={reason}
                                  onClick={() => handleDismissPending(reason)}
                                  className="text-xs"
                                >
                                  {reason}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                  <DecisionPanel
                    request={request}
                    nextAction={nextAction}
                    agency={agency_summary}
                    lastInboundMessage={lastInboundMessage}
                    reviewState={review_state}
                    onProceed={handleProceed}
                    onNegotiate={handleNegotiate}
                    onCustomAdjust={handleCustomAdjust}
                    onWithdraw={() => setWithdrawDialogOpen(true)}
                    onNarrowScope={handleNarrowScope}
                    onAppeal={handleAppeal}
                    onAddToPhoneQueue={handleAddToPhoneQueue}
                    onResolveReview={handleResolveReview}
                    onRepair={handleResetToLastInbound}
                    isLoading={isApproving || isRevising || isResolving}
                  />
                  )}

                  {/* Copilot info below decision panel for context */}
                  <CopilotPanel
                    request={request}
                    nextAction={nextAction}
                    agency={agency_summary}
                    onChallenge={handleChallenge}
                    onRefresh={mutate}
                  />
                </div>
              </div>
            </div>
          ) : portalTaskActive ? (
            /* Portal Active Layout: Conversation | Timeline | Live View */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-4 items-start">
              <div className="md:col-span-2 lg:col-span-5 min-w-0">
                <Card className="h-full">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        Conversation
                      </CardTitle>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setShowCorrespondenceDialog(true)}
                        >
                          <Phone className="h-3 w-3 mr-1" />
                          Log Call
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setShowPasteInboundDialog(true)}
                        >
                          <ClipboardPaste className="h-3 w-3 mr-1" />
                          Paste Email
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!shouldShowConversationTabs && pendingAgencyCandidatesCount > 0 && (
                      <div className="rounded border border-amber-700/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                        {pendingAgencyCandidatesCount} suggested agenc{pendingAgencyCandidatesCount === 1 ? "y" : "ies"} not yet added to case.
                        Add them in the <span className="font-medium">Agency</span> tab to split conversation by agency.
                      </div>
                    )}
                    {shouldShowConversationTabs && (
                      <ScrollArea className="w-full whitespace-nowrap">
                        <div className="flex items-center gap-1 pb-1">
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
                    )}
                    <Thread messages={visibleThreadMessages} />
                    <Separator />
                    <Composer onSend={handleSendMessage} />
                  </CardContent>
                </Card>
              </div>

              <div className="md:col-span-1 lg:col-span-3 min-w-0">
                <Card className="h-full">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span>Timeline</span>
                      {state_deadline && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {state_deadline.state_code} - {state_deadline.response_days} business days
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {deadline_milestones && deadline_milestones.length > 0 && (
                      <DeadlineCalculator
                        milestones={deadline_milestones}
                        stateDeadline={state_deadline}
                        compact
                      />
                    )}
                    {deadline_milestones && deadline_milestones.length > 0 && <Separator />}
                    <Timeline events={timeline_events} />
                  </CardContent>
                </Card>
              </div>

              <div className="md:col-span-1 lg:col-span-4 min-w-0">
                <div className="sticky top-44">
                  <PortalLiveView
                    caseId={id!}
                    initialScreenshotUrl={request.last_portal_screenshot_url}
                    portalTaskUrl={request.last_portal_task_url}
                  />
                </div>
              </div>
            </div>
          ) : (
            /* Not Paused Layout: Timeline | Conversation | Copilot */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
              <Card className="h-full min-w-0">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span>Timeline</span>
                    {state_deadline && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {state_deadline.state_code} - {state_deadline.response_days} business days
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Deadline Progress (compact) */}
                  {deadline_milestones && deadline_milestones.length > 0 && (
                    <DeadlineCalculator
                      milestones={deadline_milestones}
                      stateDeadline={state_deadline}
                      compact
                    />
                  )}
                  {deadline_milestones && deadline_milestones.length > 0 && <Separator />}
                  {/* Activity Timeline */}
                  <Timeline events={timeline_events} />
                </CardContent>
              </Card>

              <Card className="h-full min-w-0">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Conversation</CardTitle>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setShowCorrespondenceDialog(true)}
                      >
                        <Phone className="h-3 w-3 mr-1" />
                        Log Call
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setShowPasteInboundDialog(true)}
                      >
                        <ClipboardPaste className="h-3 w-3 mr-1" />
                        Paste Email
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!shouldShowConversationTabs && pendingAgencyCandidatesCount > 0 && (
                    <div className="rounded border border-amber-700/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
                      {pendingAgencyCandidatesCount} suggested agenc{pendingAgencyCandidatesCount === 1 ? "y" : "ies"} not yet added to case.
                      Add them in the <span className="font-medium">Agency</span> tab to split conversation by agency.
                    </div>
                  )}
                  {shouldShowConversationTabs && (
                    <ScrollArea className="w-full whitespace-nowrap">
                      <div className="flex items-center gap-1 pb-1">
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
                  )}
                  <Thread messages={visibleThreadMessages} />
                  <Separator />
                  <Composer onSend={handleSendMessage} />
                </CardContent>
              </Card>

              <div className="space-y-4 min-w-0">
                {hasPortalHistory && (
                  <PortalLiveView
                    caseId={id!}
                    portalTaskUrl={request.last_portal_task_url}
                    isLive={false}
                  />
                )}
                <Card className="h-full">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Copilot</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CopilotPanel
                      request={request}
                      nextAction={nextAction}
                      agency={agency_summary}
                      onChallenge={handleChallenge}
                      onRefresh={mutate}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Case Info Tab */}
        <TabsContent value="case-info" className="mt-4">
          <CaseInfoTab
            request={request}
            agencySummary={agency_summary}
            deadlineMilestones={deadline_milestones}
            stateDeadline={state_deadline}
          />
        </TabsContent>

        {/* Runs Tab */}
        <TabsContent value="runs" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Agent Runs</CardTitle>
              <Button variant="outline" size="sm" onClick={() => mutateRuns()}>
                <RefreshCw className="h-4 w-4 mr-1" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {!runsData?.runs || runsData.runs.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No agent runs recorded for this case
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run ID</TableHead>
                      <TableHead>Case</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Completed</TableHead>
                      <TableHead>Current Step</TableHead>
                      <TableHead>Links</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runsData.runs.map((run) => (
                      <TableRow
                        key={run.id}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => router.push(`/runs?run_id=${run.id}`)}
                      >
                        <TableCell className="font-mono text-sm">
                          {String(run.id).slice(0, 8)}...
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          #{run.case_id}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{run.trigger_type}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              run.status === 'completed' ? 'default' :
                              run.status === 'failed' ? 'destructive' :
                              ['running', 'processing', 'queued', 'created'].includes(run.status) ? 'secondary' :
                              run.status === 'waiting' ? 'outline' :
                              run.status === 'gated' ? 'outline' :
                              'secondary'
                            }
                            className={cn(
                              run.status === 'completed' && 'bg-green-500/10 text-green-400',
                              ['running', 'processing'].includes(run.status) && 'bg-blue-500/10 text-blue-400',
                              ['queued', 'created'].includes(run.status) && 'bg-indigo-500/10 text-indigo-400',
                              run.status === 'waiting' && 'bg-amber-500/10 text-amber-400 border-amber-700/50'
                            )}
                          >
                            {run.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(run.started_at)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {run.completed_at ? formatDate(run.completed_at) : '-'}
                        </TableCell>
                        <TableCell>
                          {run.current_node ? (
                            <Badge variant="secondary" className="text-xs">
                              {String(run.current_node).replace(/_/g, " ")}
                            </Badge>
                          ) : run.node_trace && run.node_trace.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {run.node_trace.slice(0, 3).map((node, i) => (
                                <Badge key={i} variant="secondary" className="text-xs">
                                  {node}
                                </Badge>
                              ))}
                              {run.node_trace.length > 3 && (
                                <Badge variant="secondary" className="text-xs">
                                  +{run.node_trace.length - 3}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {isAdmin && run.trigger_run_id && (
                              <a
                                href={buildTriggerRunUrl(run.trigger_run_id) || "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-400 hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                Trigger
                              </a>
                            )}
                            {isAdmin && run.skyvern_task_url && (
                              <a
                                href={run.skyvern_task_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-orange-400 hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                Skyvern
                              </a>
                            )}
                            {!isAdmin && (
                              <span className="text-xs text-muted-foreground">admin only</span>
                            )}
                            {isAdmin && !run.trigger_run_id && !run.skyvern_task_url && (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Re-run this execution"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const confirmed = window.confirm(
                                `Replay run ${String(run.id).slice(0, 8)} for case #${run.case_id}?\n\nThis queues a new run and can alter queue state.`
                              );
                              if (!confirmed) return;
                              try {
                                const result = await requestsAPI.replayAgentRun(id!, run.id);
                                if (result.success) {
                                  mutateRuns();
                                }
                              } catch (error: any) {
                                alert(error.message || "Failed to replay run");
                              }
                            }}
                          >
                            <RefreshCw className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {/* Show error details for failed runs */}
              {runsData?.runs?.filter(r => r.status === 'failed' && r.error_message).map((run) => (
                <div key={`error-${run.id}`} className="mt-4 p-4 bg-red-950/30 border border-red-800">
                  <div className="flex items-center gap-2 mb-2">
                    <XCircle className="h-4 w-4 text-red-400" />
                    <span className="font-medium text-red-300">
                      Run {String(run.id).slice(0, 8)} Failed
                    </span>
                  </div>
                  <pre className="text-xs text-red-400 whitespace-pre-wrap font-mono bg-red-950/50 p-2">
                    {run.error_message}
                  </pre>
                </div>
              ))}

              {/* Show gated reason for gated runs */}
              {runsData?.runs?.filter(r => r.status === 'gated' && r.gated_reason).map((run) => (
                <div key={`gated-${run.id}`} className="mt-4 p-4 bg-amber-950/20 border border-amber-700/50">
                  <div className="flex items-center gap-2 mb-2">
                    <UserCheck className="h-4 w-4 text-amber-400" />
                    <span className="font-medium text-amber-300">
                      Run {String(run.id).slice(0, 8)} Awaiting Approval
                    </span>
                  </div>
                  <p className="text-sm text-amber-400">{run.gated_reason}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agent Log Tab */}
        <TabsContent value="agent-log" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Agent Decision Log</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {(agentDecisions.length > 0
                  ? agentDecisions.map((decision) => ({
                      id: `decision-${decision.id}`,
                      type: decision.action_taken || "DECISION",
                      timestamp: decision.created_at,
                      summary: normalizeDecisionReasoning(decision.reasoning),
                      raw_reasoning: decision.reasoning,
                      confidence: decision.confidence,
                      outcome: decision.outcome,
                      trigger_type: decision.trigger_type,
                    }))
                  : timeline_events.filter((e) => e.ai_audit).map((event) => ({
                      id: event.id,
                      type: event.type,
                      timestamp: event.timestamp,
                      summary: event.summary || "Decision event",
                      raw_reasoning: event.ai_audit || event.metadata || null,
                      confidence: event.ai_audit?.confidence,
                      outcome: null,
                      trigger_type: null,
                    })))
                  .map((entry) => (
                    <div key={entry.id} className="border rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <Badge variant="outline">{entry.type}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(entry.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm font-medium mb-2 whitespace-pre-wrap">
                        {entry.summary || "No summary recorded"}
                      </p>
                      <div className="bg-muted rounded p-3 text-sm space-y-2">
                        {typeof entry.confidence === "number" && (
                          <p className="text-xs text-muted-foreground">
                            Confidence: {Math.round(entry.confidence * 100)}%
                          </p>
                        )}
                        {entry.trigger_type && (
                          <p className="text-xs text-muted-foreground">Trigger: {entry.trigger_type}</p>
                        )}
                        {entry.outcome && (
                          <p className="text-xs text-muted-foreground">Outcome: {entry.outcome}</p>
                        )}
                        {entry.raw_reasoning && (
                          <details className="text-xs">
                            <summary className="cursor-pointer text-muted-foreground">Full decision details</summary>
                            <pre className="mt-2 whitespace-pre-wrap bg-background/60 border rounded p-2 text-[11px]">
                              {typeof entry.raw_reasoning === "string"
                                ? entry.raw_reasoning
                                : JSON.stringify(entry.raw_reasoning, null, 2)}
                            </pre>
                          </details>
                        )}
                      </div>
                    </div>
                  ))}
                {agentDecisions.length === 0 && timeline_events.filter((e) => e.ai_audit).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No agent decisions recorded
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agency Tab */}
        <TabsContent value="agency" className="mt-4">
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>{agency_summary.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">State</p>
                  <p className="font-medium">{agency_summary.state}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Submission Method</p>
                  <Badge variant="outline">{agency_summary.submission_method}</Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Default Autopilot</p>
                  <p className="font-medium">{agency_summary.default_autopilot_mode}</p>
                </div>
                {agency_summary.portal_url && (
                  <div>
                    <p className="text-sm text-muted-foreground">Portal</p>
                    <a
                      href={agency_summary.portal_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      Open Portal
                    </a>
                  </div>
                )}
              </div>
              {agency_summary.notes && (
                <div>
                  <p className="text-sm text-muted-foreground">Notes</p>
                  <pre className="text-xs whitespace-pre-wrap bg-muted rounded p-2">{formatAgencyNotes(agency_summary.notes)}</pre>
                </div>
              )}
              <Separator />
              {hasAgencyDetailLink ? (
                <Link
                  href={`/agencies/detail?id=${agency_summary.id}`}
                  className="text-primary hover:underline inline-block"
                >
                  View Full Agency Profile
                </Link>
              ) : (
                <span className="text-muted-foreground text-sm inline-block">
                  Agency profile unavailable
                </span>
              )}
            </CardContent>
          </Card>

          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Case Agencies ({case_agencies.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded border p-3">
                <p className="text-sm font-medium mb-2">Add Agency</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <Input
                    value={manualAgencyName}
                    onChange={(e) => setManualAgencyName(e.target.value)}
                    placeholder="Agency name"
                  />
                  <Input
                    value={manualAgencyEmail}
                    onChange={(e) => setManualAgencyEmail(e.target.value)}
                    placeholder="Email (optional)"
                  />
                  <Input
                    value={manualAgencyPortalUrl}
                    onChange={(e) => setManualAgencyPortalUrl(e.target.value)}
                    placeholder="Portal URL (optional)"
                  />
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isManualAgencySubmitting || !manualAgencyName.trim()}
                    onClick={() => handleAddManualAgency(false)}
                  >
                    {isManualAgencySubmitting ? "Adding..." : "Add Agency"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={isManualAgencySubmitting || !manualAgencyName.trim()}
                    onClick={() => handleAddManualAgency(true)}
                  >
                    {isManualAgencySubmitting ? "Starting..." : "Add & Start"}
                  </Button>
                </div>
              </div>

              {case_agencies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No linked case agencies yet.</p>
              ) : (
                case_agencies.map((ca: CaseAgency) => (
                  <div key={ca.id} className="rounded border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{ca.agency_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {ca.agency_email || "No email"} {ca.portal_url ? `• Portal` : ""}
                        </p>
                        <div className="mt-2 flex gap-2">
                          {ca.is_primary && <Badge>Primary</Badge>}
                          <Badge variant="outline">{ca.status || "pending"}</Badge>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {!ca.is_primary && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={agencyActionLoadingId === ca.id || ca.id <= 0}
                            onClick={() => handleSetPrimaryAgency(ca.id)}
                          >
                            Set Primary
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={agencyActionLoadingId === ca.id || ca.id <= 0}
                          onClick={() => handleResearchAgency(ca.id)}
                        >
                          {agencyActionLoadingId === ca.id ? "Researching..." : "Research"}
                        </Button>
                        <Button
                          size="sm"
                          disabled={agencyStartLoadingId === ca.id || ca.id <= 0}
                          onClick={() => handleStartRequestForAgency(ca.id)}
                        >
                          {agencyStartLoadingId === ca.id ? "Starting..." : "Start Request"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {agency_candidates.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Research Candidates</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {agency_candidates.map((candidate: AgencyCandidate, idx: number) => (
                  <div key={`${candidate.name || "candidate"}-${idx}`} className="rounded border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{candidate.name || "Unnamed agency"}</p>
                        <p className="text-xs text-muted-foreground">
                          {candidate.agency_email || "No email"} {candidate.portal_url ? "• Portal found" : ""}
                        </p>
                        {candidate.reason && (
                          <p className="text-xs text-muted-foreground mt-1">{candidate.reason}</p>
                        )}
                        <div className="mt-2 flex gap-2">
                          {candidate.source && <Badge variant="outline">{candidate.source}</Badge>}
                          {typeof candidate.confidence === "number" && (
                            <Badge variant="outline">{Math.round(candidate.confidence * 100)}% confidence</Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !candidate.name ||
                          candidateActionLoadingName === candidate.name ||
                          candidateStartLoadingName === candidate.name
                        }
                        onClick={() => handleAddCandidateAgency(candidate)}
                      >
                        {candidateActionLoadingName === candidate.name ? "Adding..." : "Add To Case"}
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          !candidate.name ||
                          candidateActionLoadingName === candidate.name ||
                          candidateStartLoadingName === candidate.name
                        }
                        onClick={() => handleAddCandidateAgency(candidate, true)}
                      >
                        {candidateStartLoadingName === candidate.name ? "Starting..." : "Add & Start"}
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Adjust Modal */}
      <AdjustModal
        open={adjustModalOpen}
        onOpenChange={setAdjustModalOpen}
        onSubmit={handleRevise}
        constraints={request.constraints}
        isLoading={isRevising}
      />

      {/* Pending Proposal Adjust Modal */}
      <AdjustModal
        open={pendingAdjustModalOpen}
        onOpenChange={setPendingAdjustModalOpen}
        onSubmit={handleAdjustPending}
        constraints={request.constraints}
        isLoading={isAdjustingPending}
      />

      {/* Snooze Modal */}
      <SnoozeModal
        open={snoozeModalOpen}
        onOpenChange={setSnoozeModalOpen}
        onSnooze={handleSnooze}
      />

      {/* Withdraw Confirmation Dialog */}
      <Dialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw Request</DialogTitle>
            <DialogDescription>
              This will permanently close this FOIA request. The case will be marked as withdrawn and no further actions will be taken. Are you sure?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleWithdraw} disabled={isResolving}>
              {isResolving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Ban className="h-4 w-4 mr-1" />}
              Withdraw Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inbound Message Selection Dialog */}
      <Dialog open={showInboundDialog} onOpenChange={setShowInboundDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Select Inbound Message to Process</DialogTitle>
            <DialogDescription>
              Choose an unprocessed inbound message to run through the agent pipeline
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[400px]">
            {unprocessedInboundMessages.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No unprocessed inbound messages
              </p>
            ) : (
              <div className="space-y-2">
                {unprocessedInboundMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "border rounded-lg p-3 cursor-pointer transition-colors",
                      selectedMessageId === msg.id
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted/50"
                    )}
                    onClick={() => setSelectedMessageId(msg.id)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm">
                        {msg.subject || "(No subject)"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(msg.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {msg.body?.slice(0, 150)}...
                    </p>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => {
                setShowInboundDialog(false);
                setSelectedMessageId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => selectedMessageId && handleRunInbound(selectedMessageId)}
              disabled={!selectedMessageId || isRunningInbound}
            >
              {isRunningInbound ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  Process Message
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Paste Inbound Email Dialog */}
      <PasteInboundDialog
        open={showPasteInboundDialog}
        onOpenChange={setShowPasteInboundDialog}
        caseId={parseInt(id || '0')}
        onSuccess={() => mutate()}
      />

      {/* Add Correspondence Dialog */}
      <AddCorrespondenceDialog
        open={showCorrespondenceDialog}
        onOpenChange={setShowCorrespondenceDialog}
        caseId={parseInt(id || '0')}
        onSuccess={() => mutate()}
      />
    </div>
  );
}

export default function RequestDetailPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <RequestDetailContent />
    </Suspense>
  );
}
