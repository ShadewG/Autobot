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
import { GateStatusChips } from "@/components/gate-status-chips";
import { DueDisplay } from "@/components/due-display";
import { Timeline } from "@/components/timeline";
import { Thread } from "@/components/thread";
import { Composer } from "@/components/composer";
import { CopilotPanel } from "@/components/copilot-panel";
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
} from "lucide-react";

function RequestDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [nextAction, setNextAction] = useState<NextAction | null>(null);

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
    await requestsAPI.approve(id, nextAction?.id);
    mutate();
  };

  const handleRevise = async (instruction: string) => {
    if (!id) return;
    const result = await requestsAPI.revise(id, instruction, nextAction?.id);
    if (result.next_action_proposal) {
      setNextAction(result.next_action_proposal);
    }
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
          className="mb-3"
        />

        {/* Dates row */}
        <div className="flex items-center gap-4 flex-wrap text-sm">
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

        {/* Action buttons row */}
        <div className="flex items-center gap-2 mt-3">
          {nextAction && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" onClick={handleApprove}>
                    <CheckCircle className="h-4 w-4 mr-1" />
                    Approve & Send: {nextAction.proposal_short || nextAction.proposal.split('.')[0]}
                  </Button>
                </TooltipTrigger>
                {nextAction.draft_preview && (
                  <TooltipContent className="max-w-sm">
                    <p className="text-xs whitespace-pre-wrap">{nextAction.draft_preview}</p>
                  </TooltipContent>
                )}
              </Tooltip>
              <Button size="sm" variant="outline">
                <Edit className="h-4 w-4 mr-1" />
                Adjust
              </Button>
            </>
          )}
          <Button size="sm" variant="outline">
            <XCircle className="h-4 w-4 mr-1" />
            Withdraw
          </Button>
          <Button size="sm" variant="outline">
            <CheckCircle className="h-4 w-4 mr-1" />
            Complete
          </Button>
        </div>
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
                  onApprove={handleApprove}
                  onRevise={handleRevise}
                  onDismiss={handleDismiss}
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
