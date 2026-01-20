"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GateStatusChips } from "@/components/gate-status-chips";
import { DueDisplay } from "@/components/due-display";
import { Timeline } from "@/components/timeline";
import { Thread } from "@/components/thread";
import { Composer } from "@/components/composer";
import { CopilotPanel } from "@/components/copilot-panel";
import { AdjustModal } from "@/components/adjust-modal";
import { requestsAPI, fetcher } from "@/lib/api";
import type { RequestWorkspaceResponse, NextAction } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import {
  ArrowLeft,
  CheckCircle,
  Edit,
  XCircle,
  Loader2,
  Calendar,
  Clock,
  MoreHorizontal,
  Ban,
  AlarmClock,
  Globe,
  Mail,
  FileText,
  ExternalLink,
  DollarSign,
} from "lucide-react";
import { PauseReasonBar } from "@/components/pause-reason-bar";
import { ApprovalDiff } from "@/components/approval-diff";
import { ProposalStatus, ProposalStatusBadge, type ProposalState } from "@/components/proposal-status";
import { SnoozeModal } from "@/components/snooze-modal";
import { RecipientDisplay } from "@/components/recipient-display";
import { Input } from "@/components/ui/input";

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
  const [costCap, setCostCap] = useState<string>("");
  const [showCostCapInput, setShowCostCapInput] = useState(false);

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

  const handleApprove = async () => {
    if (!id) return;
    setIsApproving(true);
    try {
      const result = await requestsAPI.approve(id, nextAction?.id, costCap ? parseFloat(costCap) : undefined);
      setProposalState("QUEUED");
      // Calculate estimated send time (2-10 hours from now)
      const minDelay = 2 * 60 * 60 * 1000; // 2 hours
      const maxDelay = 10 * 60 * 60 * 1000; // 10 hours
      const randomDelay = minDelay + Math.random() * (maxDelay - minDelay);
      const estimated = new Date(Date.now() + randomDelay);
      setScheduledSendAt(result?.scheduled_send_at || estimated.toISOString());
      mutate();
    } finally {
      setIsApproving(false);
    }
  };

  const handleSnooze = async (snoozeUntil: string) => {
    if (!id) return;
    // TODO: Implement snooze API endpoint
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

  const handleDismiss = async () => {
    if (!id) return;
    await requestsAPI.dismiss(id, nextAction?.id);
    setNextAction(null);
    mutate();
  };

  const handleSendMessage = async (content: string) => {
    // This would send a manual message
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

  const { request, timeline_events, thread_messages, agency_summary } = data;

  return (
    <div className="space-y-6">
      {/* Sticky Header */}
      <div className="sticky top-14 z-40 bg-background border-b pb-4 -mx-6 px-6 pt-2">
        <div className="flex items-center gap-4 mb-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/requests")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <div>
            <h1 className="text-lg font-semibold">
              Request #{request.id} — {request.subject}
            </h1>
            <p className="text-sm text-muted-foreground">{request.agency_name}</p>
          </div>
        </div>

        {/* Status chips row */}
        <GateStatusChips
          status={request.status}
          pauseReason={request.pause_reason}
          autopilotMode={request.autopilot_mode}
          requiresHuman={request.requires_human}
          blockedReason={nextAction?.blocked_reason}
          className="mb-2"
        />

        {/* Why paused - single line explanation */}
        {request.requires_human && request.pause_reason && (
          <PauseReasonBar
            pauseReason={request.pause_reason}
            costAmount={request.cost_amount}
            autopilotMode={request.autopilot_mode}
            agencyRules={agency_summary.rules}
            blockedReason={nextAction?.blocked_reason}
          />
        )}

        {/* Dates row */}
        <div className="flex items-center gap-4 flex-wrap text-sm mt-3">
          <div className="flex items-center gap-1 text-muted-foreground">
            <Calendar className="h-3 w-3" />
            <span>Submitted: {formatDate(request.submitted_at)}</span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>Last Inbound: {formatDate(request.last_inbound_at)}</span>
          </div>
          <Separator orientation="vertical" className="h-4" />
          <DueDisplay
            dueInfo={request.due_info}
            nextDueAt={request.next_due_at}
            statutoryDueAt={request.statutory_due_at}
          />
        </div>

        {/* Quick links row - Last inbound + Draft */}
        <div className="flex items-center gap-3 mt-3 text-xs">
          {thread_messages.filter(m => m.direction === 'INBOUND').length > 0 && (
            <button
              onClick={() => {
                const lastInbound = thread_messages.filter(m => m.direction === 'INBOUND').pop();
                if (lastInbound) {
                  document.getElementById(`msg-${lastInbound.id}`)?.scrollIntoView({ behavior: 'smooth' });
                }
              }}
              className="flex items-center gap-1 text-primary hover:underline"
            >
              <Mail className="h-3 w-3" />
              Last inbound
            </button>
          )}
          {nextAction?.draft_content && (
            <button
              onClick={() => {
                // Scroll to draft preview in copilot panel
                document.querySelector('[data-draft-preview]')?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="flex items-center gap-1 text-primary hover:underline"
            >
              <FileText className="h-3 w-3" />
              View draft
            </button>
          )}
        </div>

        {/* Status display after approval */}
        {proposalState !== "PENDING" && (
          <div className="mt-3">
            <ProposalStatus
              state={proposalState}
              scheduledFor={scheduledSendAt}
            />
          </div>
        )}

        {/* Action buttons row - Primary + Secondary + Overflow */}
        {proposalState === "PENDING" && (
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            {/* Recipient display - critical for trust */}
            {nextAction && (
              <RecipientDisplay
                channel={nextAction.channel || agency_summary.submission_method}
                recipientEmail={nextAction.recipient_email || request.agency_email || undefined}
                portalProvider={nextAction.portal_provider || agency_summary.portal_provider}
              />
            )}

            {/* Primary: Approve & Queue (or Queue Portal Run for portal) */}
            {nextAction && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" onClick={handleApprove} disabled={isApproving}>
                    {isApproving ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (nextAction.channel || agency_summary.submission_method) === 'PORTAL' ? (
                      <Globe className="h-4 w-4 mr-1" />
                    ) : (
                      <CheckCircle className="h-4 w-4 mr-1" />
                    )}
                    {(nextAction.channel || agency_summary.submission_method) === 'PORTAL'
                      ? `Queue Portal Run: ${nextAction.proposal_short || 'Submit'}`
                      : `Approve & Queue: ${nextAction.proposal_short || nextAction.proposal.split('.')[0]}`
                    }
                  </Button>
                </TooltipTrigger>
                {nextAction.draft_preview && (
                  <TooltipContent className="max-w-sm">
                    <p className="text-xs whitespace-pre-wrap">{nextAction.draft_preview}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            )}

            {/* Cost cap pill - inline */}
            {nextAction && request.pause_reason === 'FEE_QUOTE' && (
              <>
                {showCostCapInput ? (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">Cap:</span>
                    <Input
                      type="number"
                      placeholder="$"
                      value={costCap}
                      onChange={(e) => setCostCap(e.target.value)}
                      className="w-20 h-7 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setShowCostCapInput(false)}
                    >
                      <XCircle className="h-3 w-3" />
                    </Button>
                  </div>
                ) : costCap ? (
                  <Badge variant="outline" className="gap-1 text-xs cursor-pointer" onClick={() => setShowCostCapInput(true)}>
                    <DollarSign className="h-3 w-3" />
                    Cap: ${costCap}
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={() => setShowCostCapInput(true)}
                  >
                    <DollarSign className="h-3 w-3 mr-1" />
                    Set cap
                  </Button>
                )}
              </>
            )}

            {/* Secondary: Adjust */}
            {nextAction && (
              <Button size="sm" variant="outline" onClick={() => setAdjustModalOpen(true)}>
                <Edit className="h-4 w-4 mr-1" />
                Adjust
              </Button>
            )}

            {/* Overflow menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {nextAction && (
                  <>
                    <DropdownMenuItem onClick={handleDismiss}>
                      <Ban className="h-4 w-4 mr-2" />
                      Dismiss proposal
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => setSnoozeModalOpen(true)}>
                  <AlarmClock className="h-4 w-4 mr-2" />
                  Snooze / Remind me
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <XCircle className="h-4 w-4 mr-2" />
                  Withdraw request
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Mark complete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* What changes if I approve - micro-diff */}
        {nextAction && proposalState === "PENDING" && (
          <div className="mt-2">
            <ApprovalDiff
              nextAction={nextAction}
              feeQuote={request.fee_quote}
              scopeItems={request.scope_items}
              costCap={costCap ? parseFloat(costCap) : undefined}
              channel={nextAction.channel || agency_summary.submission_method}
              recipientEmail={nextAction.recipient_email || request.agency_email || undefined}
              portalProvider={nextAction.portal_provider || agency_summary.portal_provider}
            />
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="agent-log">Agent Log</TabsTrigger>
          <TabsTrigger value="agency">Agency</TabsTrigger>
        </TabsList>

        {/* Overview Tab - 3 Column Layout */}
        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Timeline Column */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <Timeline events={timeline_events} />
              </CardContent>
            </Card>

            {/* Conversation Column */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Conversation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Thread messages={thread_messages} />
                <Composer onSend={handleSendMessage} />
              </CardContent>
            </Card>

            {/* Copilot Column */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Copilot</CardTitle>
              </CardHeader>
              <CardContent>
                <CopilotPanel
                  request={request}
                  nextAction={nextAction}
                  agency={agency_summary}
                />
              </CardContent>
            </Card>
          </div>
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

      {/* Adjust Modal - controlled from header */}
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
