"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense, useMemo } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import type { RequestWorkspaceResponse, NextAction, PauseReason, PendingProposal } from "@/lib/types";
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
} from "lucide-react";
import { ProposalStatus, type ProposalState } from "@/components/proposal-status";
import { SnoozeModal } from "@/components/snooze-modal";
import { AutopilotSelector } from "@/components/autopilot-selector";
import { SafetyHints } from "@/components/safety-hints";
import { PasteInboundDialog } from "@/components/paste-inbound-dialog";
import { AddCorrespondenceDialog } from "@/components/add-correspondence-dialog";

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

function RequestDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [snoozeModalOpen, setSnoozeModalOpen] = useState(false);
  const [proposalState, setProposalState] = useState<ProposalState>("PENDING");
  const [isApproving, setIsApproving] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  const [scheduledSendAt, setScheduledSendAt] = useState<string | null>(null);

  const { data, error, isLoading, mutate } = useSWR<RequestWorkspaceResponse>(
    id ? `/requests/${id}/workspace` : null,
    fetcher
  );

  // Set nextAction from data
  useEffect(() => {
    if (data?.next_action_proposal) {
      setNextAction(data.next_action_proposal);
    }
  }, [data?.next_action_proposal]);

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
      mutate();
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
      mutate();
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
      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVE" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      mutate();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsApproving(false);
    }
  };

  const handleDismissPending = async () => {
    if (!data?.pending_proposal) return;
    const dismissLabel = isEmailLikePendingAction ? "draft" : "proposal";
    if (!confirm(`Dismiss this ${dismissLabel}? The AI will need to re-analyze.`)) return;
    try {
      const res = await fetch(`/api/proposals/${data.pending_proposal.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "DISMISS" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Failed");
      mutate();
    } catch (e: any) {
      alert(e.message);
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
    fetcher
  );

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
  const liveRunLabel = useMemo(() => formatLiveRunLabel(liveRun), [liveRun]);
  const portalTaskActive = useMemo(() => {
    const status = String(data?.request?.active_portal_task_status || "").toUpperCase();
    return status === "PENDING" || status === "IN_PROGRESS";
  }, [data?.request?.active_portal_task_status]);
  const waitingRun = useMemo(() => {
    const list = runsData?.runs || [];
    return list.find((r) => String(r.status).toLowerCase() === "waiting") || null;
  }, [runsData?.runs]);

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
    review_state,
    active_run,
  } = data;

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

  const statusValue = String(request.status || "").toUpperCase();
  const isPausedStatus = statusValue === "NEEDS_HUMAN_REVIEW" || statusValue === "PAUSED";
  const statusDisplay = isPausedStatus ? "PAUSED" : (request.status || "—");
  const pauseReasonValue = String(request.pause_reason || "").toUpperCase();
  const shouldHidePauseReason =
    !request.pause_reason ||
    (pauseReasonValue === "PENDING_APPROVAL" && Boolean(waitingRun));

  // Use server-derived review_state when available, fall back to legacy heuristic
  const isPaused = review_state
    ? review_state === 'DECISION_REQUIRED'
    : (Boolean(request.pause_reason) ||
       request.requires_human ||
       request.status?.toUpperCase() === "PAUSED" ||
       request.status?.toUpperCase() === "NEEDS_HUMAN_REVIEW" ||
       request.status?.toLowerCase().includes("needs_human"));
  const isDecisionApplying = review_state === 'DECISION_APPLYING';

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

          {/* Autopilot Mode Selector */}
          <AutopilotSelector
            requestId={request.id}
            currentMode={request.autopilot_mode}
            onModeChange={() => mutate()}
            compact
          />

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
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Status:</span>
            <Badge variant="outline" className="font-medium">
              {statusDisplay}
            </Badge>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Autopilot:</span>
            <Badge
              variant={request.autopilot_mode === 'AUTO' ? 'default' : 'secondary'}
              className="font-medium"
            >
              {request.autopilot_mode}
            </Badge>
          </div>
          {request.requires_human && !isPausedStatus && (
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
          {request.last_portal_task_url && (
            <a
              href={request.last_portal_task_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-orange-400 hover:underline text-xs"
            >
              <ExternalLink className="h-3 w-3" /> Skyvern Run
            </a>
          )}
          {request.last_portal_status && (
            <Badge variant="outline" className="text-[10px] text-red-400 border-red-700/50">
              {request.last_portal_status}
            </Badge>
          )}
          {!shouldHidePauseReason && (
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
          ) : (
            <div className="flex items-center gap-1.5 rounded border border-muted bg-muted/20 px-2 py-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Idle: no active run</span>
            </div>
          )}
        </div>

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
            <span>Submitted: {formatDate(request.submitted_at)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span>Last Inbound: {formatDate(request.last_inbound_at)}</span>
          </div>
          <Separator orientation="vertical" className="h-3" />
          <DueDisplay
            dueInfo={request.due_info}
            nextDueAt={request.next_due_at}
            statutoryDueAt={request.statutory_due_at}
          />
        </div>
      </div>

      {/* Main Content - Different layout for paused vs not paused */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
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
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              {/* Conversation - takes most space, user needs to read this first */}
              <div className="lg:col-span-5 min-w-0">
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
                    <Thread messages={thread_messages} />
                    <Separator />
                    <Composer onSend={handleSendMessage} />
                  </CardContent>
                </Card>
              </div>

              {/* Timeline - middle */}
              <div className="lg:col-span-3 min-w-0">
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
              <div className="lg:col-span-4 min-w-0">
                <div className="sticky top-44 space-y-4">
                  {pending_proposal ? (
                    <Card className="border-2 border-blue-700/50 bg-blue-500/5">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2 text-blue-300">
                          {isEmailLikePendingAction ? <Send className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                          {pendingCardTitle}
                          <Badge variant="outline" className="text-[10px] ml-auto">
                            {ACTION_TYPE_LABELS[pending_proposal.action_type]?.label || pending_proposal.action_type.replace(/_/g, " ")}
                          </Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {pending_proposal.draft_subject && (
                          <p className="text-xs font-medium truncate">
                            {pending_proposal.draft_subject}
                          </p>
                        )}
                        {pending_proposal.draft_body_text && (
                          <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-[inherit] line-clamp-6 overflow-hidden max-h-32">
                            {pending_proposal.draft_body_text}
                          </pre>
                        )}
                        {!pending_proposal.draft_subject && !pending_proposal.draft_body_text && (
                          <p className="text-xs text-muted-foreground">
                            No outbound message draft for this action. Approve to continue processing this proposal.
                          </p>
                        )}
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
                        <div className="flex gap-2 pt-1">
                          <Button
                            size="sm"
                            className="flex-1"
                            onClick={handleApprovePending}
                            disabled={isApproving}
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
                            onClick={handleDismissPending}
                            disabled={isApproving}
                          >
                            Dismiss
                          </Button>
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
          ) : (
            /* Not Paused Layout: Timeline | Conversation | Copilot */
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
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
                  <Thread messages={thread_messages} />
                  <Separator />
                  <Composer onSend={handleSendMessage} />
                </CardContent>
              </Card>

              <Card className="h-full min-w-0">
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
          )}
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
                      <TableHead>Trigger</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Completed</TableHead>
                      <TableHead>Node Trace</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runsData.runs.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="font-mono text-sm">
                          {String(run.id).slice(0, 8)}...
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
                          {run.node_trace && run.node_trace.length > 0 ? (
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
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
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
                {timeline_events
                  .filter((e) => e.ai_audit)
                  .map((event) => (
                    <div key={event.id} className="border rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <Badge variant="outline">{event.type}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(event.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm font-medium mb-2">{event.summary}</p>
                      {event.ai_audit && (
                        <div className="bg-muted rounded p-3 text-sm">
                          <p className="font-medium mb-2">AI Analysis:</p>
                          <ul className="space-y-1">
                            {(event.ai_audit.summary || []).map((point, i) => (
                              <li key={i}>• {point}</li>
                            ))}
                          </ul>
                          {event.ai_audit.confidence !== undefined && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Confidence: {Math.round(event.ai_audit.confidence * 100)}%
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                {timeline_events.filter((e) => e.ai_audit).length === 0 && (
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
          <Card>
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
                  <p>{agency_summary.notes}</p>
                </div>
              )}
              <Separator />
              <Link
                href={`/agencies/detail?id=${agency_summary.id}`}
                className="text-primary hover:underline inline-block"
              >
                View Full Agency Profile
              </Link>
            </CardContent>
          </Card>
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
