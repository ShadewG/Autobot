"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetcher } from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
import {
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Mail,
  DollarSign,
  FileQuestion,
  ChevronRight,
  RefreshCw,
  Star,
  Eye,
  BarChart3,
  FlaskConical,
  MessageSquare,
} from "lucide-react";

interface ShadowProposal {
  id: number;
  case_id: number;
  case_name?: string;
  agency_name?: string;
  action_type: string;
  draft_subject?: string;
  draft_body_text?: string;
  reasoning?: string[];
  confidence?: number;
  classification?: string;
  status: string;
  created_at: string;
  has_review?: boolean;
}

interface ProposalDetail {
  proposal: ShadowProposal;
  case: {
    id: number;
    case_name: string;
    agency_name: string;
    status: string;
    autopilot_mode: string;
  };
  run?: {
    id: number;
    trigger_type: string;
    autopilot_mode: string;
    status: string;
  };
  decision_trace?: unknown;
  recent_messages: Array<{
    id: number;
    direction: string;
    subject: string;
    body_preview: string;
    created_at: string;
  }>;
  existing_review?: {
    routing_correct: string;
    gating_correct: string;
    draft_quality_score: number;
    draft_feedback?: string;
    reviewed_at: string;
  };
}

interface ShadowMetrics {
  total_proposals: number;
  reviewed: number;
  pending_review: number;
  routing_accuracy: number;
  gating_accuracy: number;
  avg_draft_quality: number;
}

const ACTION_TYPE_LABELS: Record<string, string> = {
  SEND_EMAIL: "Send Email",
  SEND_REPLY: "Send Reply",
  ACCEPT_FEE: "Accept Fee",
  NEGOTIATE_FEE: "Negotiate Fee",
  APPEAL: "Appeal",
  NARROW_SCOPE: "Narrow Scope",
  FOLLOW_UP: "Follow Up",
  WITHDRAW: "Withdraw",
};

export default function ShadowModePage() {
  const [selectedProposal, setSelectedProposal] = useState<ShadowProposal | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Review form state
  const [routingCorrect, setRoutingCorrect] = useState<string>("");
  const [correctClassification, setCorrectClassification] = useState<string>("");
  const [gatingCorrect, setGatingCorrect] = useState<string>("");
  const [draftQuality, setDraftQuality] = useState<number>(0);
  const [draftFeedback, setDraftFeedback] = useState<string>("");

  // Fetch proposals
  const { data: proposalsData, error, isLoading, mutate } = useSWR<{
    success: boolean;
    count: number;
    proposals: ShadowProposal[];
  }>(
    `/shadow/proposals?limit=100&includeReviewed=${showReviewed}`,
    fetcher,
    { refreshInterval: 30000 }
  );

  // Fetch metrics
  const { data: metricsData } = useSWR<{ success: boolean; metrics: ShadowMetrics }>(
    "/shadow/metrics",
    fetcher,
    { refreshInterval: 60000 }
  );

  // Fetch proposal detail when selected
  const { data: detailData, mutate: mutateDetail } = useSWR<{ success: boolean } & ProposalDetail>(
    selectedProposal ? `/shadow/proposals/${selectedProposal.id}` : null,
    fetcher
  );

  const handleSelectProposal = (proposal: ShadowProposal) => {
    setSelectedProposal(proposal);
    // Reset form
    setRoutingCorrect("");
    setCorrectClassification("");
    setGatingCorrect("");
    setDraftQuality(0);
    setDraftFeedback("");
  };

  const handleSubmitReview = async () => {
    if (!selectedProposal) return;
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/shadow/proposals/${selectedProposal.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routingCorrect: routingCorrect || undefined,
          correctClassification: correctClassification || undefined,
          gatingCorrect: gatingCorrect || undefined,
          draftQualityScore: draftQuality || undefined,
          draftFeedback: draftFeedback || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to submit review");
      }

      // Refresh data
      mutate();
      mutateDetail();

      // Move to next unreviewed proposal
      const nextProposal = proposalsData?.proposals.find(
        (p) => p.id !== selectedProposal.id && !p.has_review
      );
      if (nextProposal) {
        handleSelectProposal(nextProposal);
      } else {
        setSelectedProposal(null);
      }
    } catch (error) {
      console.error("Error submitting review:", error);
      alert("Failed to submit review");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Populate form with existing review if available
  const existingReview = detailData?.existing_review;
  const populateFromExisting = () => {
    if (existingReview) {
      setRoutingCorrect(existingReview.routing_correct || "");
      setGatingCorrect(existingReview.gating_correct || "");
      setDraftQuality(existingReview.draft_quality_score || 0);
      setDraftFeedback(existingReview.draft_feedback || "");
    }
  };

  const proposals = proposalsData?.proposals || [];
  const metrics = metricsData?.metrics;

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load proposals</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FlaskConical className="h-6 w-6" />
            Shadow Mode Review
          </h1>
          <p className="text-sm text-muted-foreground">
            Review and score DRY-executed proposals to improve model accuracy
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showReviewed ? "default" : "outline"}
            size="sm"
            onClick={() => setShowReviewed(!showReviewed)}
          >
            {showReviewed ? "Hide Reviewed" : "Show Reviewed"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Metrics */}
      {metrics && (
        <div className="grid grid-cols-5 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Proposals</p>
                  <p className="text-2xl font-bold">{metrics.total_proposals}</p>
                </div>
                <BarChart3 className="h-8 w-8 text-muted-foreground" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Reviewed</p>
                  <p className="text-2xl font-bold">{metrics.reviewed}</p>
                </div>
                <CheckCircle className="h-8 w-8 text-green-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Pending</p>
                  <p className="text-2xl font-bold">{metrics.pending_review}</p>
                </div>
                <Clock className="h-8 w-8 text-amber-500" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Routing Accuracy</p>
                  <p className="text-2xl font-bold">
                    {metrics.routing_accuracy ? `${Math.round(metrics.routing_accuracy * 100)}%` : "—"}
                  </p>
                </div>
                <div className={cn(
                  "p-2 rounded-full",
                  metrics.routing_accuracy >= 0.8 ? "bg-green-500/15" :
                  metrics.routing_accuracy >= 0.6 ? "bg-amber-500/15" : "bg-red-500/15"
                )}>
                  <CheckCircle className="h-4 w-4" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Avg Draft Quality</p>
                  <p className="text-2xl font-bold">
                    {metrics.avg_draft_quality ? metrics.avg_draft_quality.toFixed(1) : "—"}/5
                  </p>
                </div>
                <Star className="h-8 w-8 text-amber-500" />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : proposals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" />
            <h3 className="text-lg font-semibold">All caught up!</h3>
            <p className="text-muted-foreground">No proposals pending review</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Proposals List */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Proposals ({proposals.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[600px]">
                <div className="divide-y">
                  {proposals.map((proposal) => (
                    <div
                      key={proposal.id}
                      className={cn(
                        "p-4 cursor-pointer hover:bg-muted/50 transition-colors",
                        selectedProposal?.id === proposal.id && "bg-muted",
                        proposal.has_review && "opacity-60"
                      )}
                      onClick={() => handleSelectProposal(proposal)}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium truncate">
                              {proposal.case_name || `Case #${proposal.case_id}`}
                            </p>
                            {proposal.has_review && (
                              <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground truncate">
                            {proposal.agency_name}
                          </p>
                        </div>
                        <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs">
                          {ACTION_TYPE_LABELS[proposal.action_type] || proposal.action_type}
                        </Badge>
                        {proposal.classification && (
                          <Badge variant="secondary" className="text-xs">
                            {proposal.classification}
                          </Badge>
                        )}
                        {proposal.confidence && (
                          <Badge variant="outline" className="text-xs">
                            {Math.round(proposal.confidence * 100)}% conf
                          </Badge>
                        )}
                      </div>

                      <p className="text-xs text-muted-foreground mt-2">
                        {formatDate(proposal.created_at)}
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Review Panel */}
          <Card className="lg:col-span-1">
            {selectedProposal && detailData ? (
              <>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Review Proposal</CardTitle>
                    <Link
                      href={`/requests/detail?id=${selectedProposal.case_id}`}
                      className="text-sm text-primary hover:underline"
                    >
                      View Case
                    </Link>
                  </div>
                </CardHeader>
                <ScrollArea className="h-[600px]">
                  <CardContent className="space-y-4">
                    {/* Case Context */}
                    <div className="bg-muted/50 rounded-lg p-3">
                      <p className="font-medium">{detailData.case.case_name}</p>
                      <p className="text-sm text-muted-foreground">
                        {detailData.case.agency_name}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge variant="outline" className="text-xs">
                          {detailData.case.status}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {detailData.case.autopilot_mode}
                        </Badge>
                      </div>
                    </div>

                    {/* Recent Messages */}
                    {detailData.recent_messages.length > 0 && (
                      <div>
                        <p className="text-sm font-medium mb-2 flex items-center gap-1">
                          <MessageSquare className="h-4 w-4" />
                          Recent Messages
                        </p>
                        <div className="space-y-2">
                          {detailData.recent_messages.map((msg) => (
                            <div
                              key={msg.id}
                              className={cn(
                                "p-2 rounded text-sm",
                                msg.direction === "inbound"
                                  ? "bg-blue-500/10 border-l-2 border-blue-500"
                                  : "bg-muted border-l-2 border-border"
                              )}
                            >
                              <p className="font-medium text-xs">
                                {msg.direction === "inbound" ? "Agency" : "Outbound"}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {msg.subject}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Proposal Draft */}
                    <div>
                      <p className="text-sm font-medium mb-2 flex items-center gap-1">
                        <Mail className="h-4 w-4" />
                        Draft Response
                      </p>
                      {detailData.proposal.draft_subject && (
                        <p className="text-sm mb-2">
                          <span className="text-muted-foreground">Subject:</span>{" "}
                          {detailData.proposal.draft_subject}
                        </p>
                      )}
                      <div className="bg-muted/50 rounded-lg p-3 max-h-[200px] overflow-auto">
                        <pre className="text-sm whitespace-pre-wrap font-sans">
                          {detailData.proposal.draft_body_text || "(No content)"}
                        </pre>
                      </div>
                    </div>

                    {/* Reasoning */}
                    {detailData.proposal.reasoning && detailData.proposal.reasoning.length > 0 && (
                      <div>
                        <p className="text-sm font-medium mb-2">AI Reasoning:</p>
                        <ul className="text-sm space-y-1">
                          {detailData.proposal.reasoning.map((r, i) => (
                            <li key={i}>• {r}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <Separator />

                    {/* Review Form */}
                    <div className="space-y-4">
                      <p className="text-sm font-medium">Your Review</p>

                      {existingReview && (
                        <div className="bg-green-500/10 border border-green-700/50 rounded-lg p-3">
                          <p className="text-sm text-green-300 flex items-center gap-1">
                            <CheckCircle className="h-4 w-4" />
                            Already reviewed on {formatDate(existingReview.reviewed_at)}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-2"
                            onClick={populateFromExisting}
                          >
                            Edit Review
                          </Button>
                        </div>
                      )}

                      {/* Routing Correct */}
                      <div>
                        <Label className="text-sm font-medium">
                          Was the routing/classification correct?
                        </Label>
                        <RadioGroup
                          value={routingCorrect}
                          onValueChange={setRoutingCorrect}
                          className="flex gap-4 mt-2"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="correct" id="routing-correct" />
                            <Label htmlFor="routing-correct" className="text-sm">Correct</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="incorrect" id="routing-incorrect" />
                            <Label htmlFor="routing-incorrect" className="text-sm">Incorrect</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="unsure" id="routing-unsure" />
                            <Label htmlFor="routing-unsure" className="text-sm">Unsure</Label>
                          </div>
                        </RadioGroup>
                      </div>

                      {/* Gating Correct */}
                      <div>
                        <Label className="text-sm font-medium">
                          Was the gating decision correct?
                        </Label>
                        <RadioGroup
                          value={gatingCorrect}
                          onValueChange={setGatingCorrect}
                          className="flex flex-wrap gap-3 mt-2"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="correct" id="gating-correct" />
                            <Label htmlFor="gating-correct" className="text-sm">Correct</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="should_have_gated" id="gating-should-gate" />
                            <Label htmlFor="gating-should-gate" className="text-sm">Should've gated</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="should_not_have_gated" id="gating-should-not-gate" />
                            <Label htmlFor="gating-should-not-gate" className="text-sm">Shouldn't have gated</Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="unsure" id="gating-unsure" />
                            <Label htmlFor="gating-unsure" className="text-sm">Unsure</Label>
                          </div>
                        </RadioGroup>
                      </div>

                      {/* Draft Quality */}
                      <div>
                        <Label className="text-sm font-medium">
                          Draft quality (1-5)
                        </Label>
                        <div className="flex gap-2 mt-2">
                          {[1, 2, 3, 4, 5].map((score) => (
                            <Button
                              key={score}
                              variant={draftQuality === score ? "default" : "outline"}
                              size="sm"
                              onClick={() => setDraftQuality(score)}
                              className="w-10"
                            >
                              {score}
                            </Button>
                          ))}
                        </div>
                      </div>

                      {/* Feedback */}
                      <div>
                        <Label className="text-sm font-medium">
                          Feedback (optional)
                        </Label>
                        <Textarea
                          placeholder="What could be improved?"
                          value={draftFeedback}
                          onChange={(e) => setDraftFeedback(e.target.value)}
                          className="mt-2"
                        />
                      </div>

                      <Button
                        className="w-full"
                        onClick={handleSubmitReview}
                        disabled={isSubmitting || (!routingCorrect && !gatingCorrect && !draftQuality)}
                      >
                        {isSubmitting ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <CheckCircle className="h-4 w-4 mr-1" />
                        )}
                        Submit Review
                      </Button>
                    </div>
                  </CardContent>
                </ScrollArea>
              </>
            ) : selectedProposal ? (
              <CardContent className="py-12 text-center">
                <Loader2 className="h-8 w-8 mx-auto animate-spin text-muted-foreground" />
              </CardContent>
            ) : (
              <CardContent className="py-12 text-center">
                <Eye className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">
                  Select a proposal to review
                </p>
              </CardContent>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
