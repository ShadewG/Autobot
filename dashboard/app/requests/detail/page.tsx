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
import { DueDisplay } from "@/components/due-display";
import { Timeline } from "@/components/timeline";
import { Thread } from "@/components/thread";
import { Composer } from "@/components/composer";
import { CopilotPanel } from "@/components/copilot-panel";
import { AdjustModal } from "@/components/adjust-modal";
import { DecisionPanel } from "@/components/decision-panel";
import { DeadlineCalculator } from "@/components/deadline-calculator";
import { requestsAPI, fetcher } from "@/lib/api";
import type { RequestWorkspaceResponse, NextAction, PauseReason } from "@/lib/types";
import { formatDate, cn } from "@/lib/utils";
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
} from "lucide-react";
import { ProposalStatus, type ProposalState } from "@/components/proposal-status";
import { SnoozeModal } from "@/components/snooze-modal";

// Gate icons and colors
const GATE_DISPLAY: Record<PauseReason, { icon: React.ReactNode; color: string; label: string }> = {
  FEE_QUOTE: {
    icon: <DollarSign className="h-4 w-4" />,
    color: "text-amber-700 bg-amber-100 border-amber-300",
    label: "Fee Quote",
  },
  DENIAL: {
    icon: <XCircle className="h-4 w-4" />,
    color: "text-red-700 bg-red-100 border-red-300",
    label: "Denial",
  },
  SCOPE: {
    icon: <FileQuestion className="h-4 w-4" />,
    color: "text-orange-700 bg-orange-100 border-orange-300",
    label: "Scope Issue",
  },
  ID_REQUIRED: {
    icon: <UserCheck className="h-4 w-4" />,
    color: "text-blue-700 bg-blue-100 border-blue-300",
    label: "ID Required",
  },
  SENSITIVE: {
    icon: <AlertTriangle className="h-4 w-4" />,
    color: "text-purple-700 bg-purple-100 border-purple-300",
    label: "Sensitive",
  },
  CLOSE_ACTION: {
    icon: <CheckCircle className="h-4 w-4" />,
    color: "text-green-700 bg-green-100 border-green-300",
    label: "Ready to Close",
  },
};

function RequestDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [nextAction, setNextAction] = useState<NextAction | null>(null);
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [snoozeModalOpen, setSnoozeModalOpen] = useState(false);
  const [proposalState, setProposalState] = useState<ProposalState>("PENDING");
  const [isApproving, setIsApproving] = useState(false);
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
    setAdjustModalOpen(true);
  };

  const handleWithdraw = async () => {
    if (!id) return;
    if (!confirm("Are you sure you want to withdraw this request? This will close it permanently.")) {
      return;
    }
    try {
      await requestsAPI.withdraw(id, "Withdrawn by user");
      mutate();
      router.push("/requests");
    } catch (error) {
      console.error("Error withdrawing request:", error);
      alert("Failed to withdraw request. Please try again.");
    }
  };

  const handleNarrowScope = () => {
    // Open adjust modal with scope narrowing preset
    setAdjustModalOpen(true);
  };

  const handleAppeal = () => {
    // Open adjust modal with appeal preset
    setAdjustModalOpen(true);
  };

  const handleChallenge = (instruction: string) => {
    // Pre-fill the adjust modal with the challenge instruction
    setAdjustModalOpen(true);
    // TODO: Could pre-fill the modal with the instruction
  };

  const handleSnooze = async (snoozeUntil: string) => {
    if (!id) return;
    console.log("Snooze until:", snoozeUntil);
    mutate();
  };

  const handleRevise = async (instruction: string) => {
    if (!id) return;
    const result = await requestsAPI.revise(id, instruction, nextAction?.id);
    if (result.next_action_proposal) {
      setNextAction(result.next_action_proposal);
    }
    setAdjustModalOpen(false);
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
  } = data;

  // Robust detection of whether request is paused (same pattern as DecisionPanel)
  const isPaused =
    Boolean(request.pause_reason) ||
    request.requires_human ||
    request.status?.toUpperCase() === "PAUSED" ||
    request.status?.toUpperCase() === "NEEDS_HUMAN_REVIEW" ||
    request.status?.toLowerCase().includes("needs_human");

  const gateDisplay = request.pause_reason ? GATE_DISPLAY[request.pause_reason] : null;

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
      <div className="sticky top-14 z-40 bg-background border-b pb-3 -mx-6 px-6 pt-2">
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
              <DropdownMenuItem onClick={handleWithdraw}>
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
                    <CardTitle className="text-base flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Conversation
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Thread messages={thread_messages} />
                    <Separator />
                    <Composer onSend={handleSendMessage} />
                  </CardContent>
                </Card>
              </div>

              {/* Timeline - middle */}
              <div className="lg:col-span-3 min-w-0 space-y-4">
                {/* Deadline Calculator */}
                {deadline_milestones && deadline_milestones.length > 0 && (
                  <DeadlineCalculator
                    milestones={deadline_milestones}
                    stateDeadline={state_deadline}
                  />
                )}
                <Card className="h-full">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Timeline</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Timeline events={timeline_events} />
                  </CardContent>
                </Card>
              </div>

              {/* Decision Panel - sticky on right */}
              <div className="lg:col-span-4 min-w-0">
                <div className="sticky top-48 space-y-4">
                  <DecisionPanel
                    request={request}
                    nextAction={nextAction}
                    agency={agency_summary}
                    lastInboundMessage={lastInboundMessage}
                    onProceed={handleProceed}
                    onNegotiate={handleNegotiate}
                    onWithdraw={handleWithdraw}
                    onNarrowScope={handleNarrowScope}
                    onAppeal={handleAppeal}
                    isLoading={isApproving}
                  />

                  {/* Copilot info below decision panel for context */}
                  <CopilotPanel
                    request={request}
                    nextAction={nextAction}
                    agency={agency_summary}
                    onChallenge={handleChallenge}
                  />
                </div>
              </div>
            </div>
          ) : (
            /* Not Paused Layout: Timeline | Conversation | Copilot */
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
              <div className="space-y-4 min-w-0">
                {/* Deadline Calculator */}
                {deadline_milestones && deadline_milestones.length > 0 && (
                  <DeadlineCalculator
                    milestones={deadline_milestones}
                    stateDeadline={state_deadline}
                  />
                )}
                <Card className="h-full">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Timeline</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Timeline events={timeline_events} />
                  </CardContent>
                </Card>
              </div>

              <Card className="h-full min-w-0">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Conversation</CardTitle>
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
                  />
                </CardContent>
              </Card>
            </div>
          )}
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
                            {event.ai_audit.summary.map((point, i) => (
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
        isLoading={false}
      />

      {/* Snooze Modal */}
      <SnoozeModal
        open={snoozeModalOpen}
        onOpenChange={setSnoozeModalOpen}
        onSnooze={handleSnooze}
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
