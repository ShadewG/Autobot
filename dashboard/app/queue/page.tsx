"use client";

import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fetchAPI, fetcher, proposalsAPI, type ProposalListItem, type ProposalsListResponse } from "@/lib/api";
import { cn, formatReasoning, ACTION_TYPE_LABELS } from "@/lib/utils";
import {
  CheckCircle,
  XCircle,
  Edit3,
  LogOut,
  Loader2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  DollarSign,
  Ban,
  FileQuestion,
  Clock,
  Send,
  MessageSquare,
  RefreshCw,
  Globe,
  Search,
} from "lucide-react";
import Link from "next/link";

// Action type icons (labels/colors come from shared ACTION_TYPE_LABELS)
const ACTION_TYPE_ICONS: Record<string, React.ReactNode> = {
  SEND_INITIAL_REQUEST: <Send className="h-4 w-4" />,
  SEND_FOLLOWUP: <Clock className="h-4 w-4" />,
  SEND_REBUTTAL: <MessageSquare className="h-4 w-4" />,
  SEND_CLARIFICATION: <FileQuestion className="h-4 w-4" />,
  SEND_APPEAL: <AlertTriangle className="h-4 w-4" />,
  ACCEPT_FEE: <DollarSign className="h-4 w-4" />,
  NEGOTIATE_FEE: <DollarSign className="h-4 w-4" />,
  DECLINE_FEE: <XCircle className="h-4 w-4" />,
  SUBMIT_PORTAL: <Globe className="h-4 w-4" />,
  ESCALATE: <AlertTriangle className="h-4 w-4" />,
};

// Pause reason labels
const PAUSE_REASON_LABELS: Record<string, string> = {
  FEE_QUOTE: "Fee Quote",
  DENIAL: "Denial",
  SCOPE: "Scope Issue",
  ID_REQUIRED: "ID Required",
  SENSITIVE: "Sensitive",
  CLOSE_ACTION: "Close Action",
};

// Sentiment badges
function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return null;

  const colors: Record<string, string> = {
    positive: "bg-green-500/10 text-green-400",
    neutral: "bg-muted text-muted-foreground",
    negative: "bg-red-500/10 text-red-400",
    hostile: "bg-red-500/20 text-red-300",
  };

  return (
    <Badge variant="outline" className={cn("text-xs", colors[sentiment] || colors.neutral)}>
      {sentiment}
    </Badge>
  );
}

// Single proposal card
function ProposalCard({
  proposal,
  onDecision,
  onLookupContact,
  isProcessing,
  isLookingUpContact,
}: {
  proposal: ProposalListItem;
  onDecision: (id: number, action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW', instruction?: string) => Promise<void>;
  onLookupContact: (caseId: number) => Promise<void>;
  isProcessing: boolean;
  isLookingUpContact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustInstruction, setAdjustInstruction] = useState("");
  const [showWithdraw, setShowWithdraw] = useState(false);

  const labelConfig = ACTION_TYPE_LABELS[proposal.action_type] || {
    label: proposal.action_type.replace(/_/g, " "),
    color: "bg-muted text-muted-foreground",
  };
  const actionConfig = {
    ...labelConfig,
    icon: ACTION_TYPE_ICONS[proposal.action_type] || <Send className="h-4 w-4" />,
  };

  const handleApprove = () => onDecision(proposal.id, 'APPROVE');
  const handleDismiss = () => onDecision(proposal.id, 'DISMISS');
  const handleAdjust = () => {
    if (adjustInstruction.trim()) {
      onDecision(proposal.id, 'ADJUST', adjustInstruction);
      setShowAdjust(false);
      setAdjustInstruction("");
    }
  };
  const handleWithdraw = () => {
    onDecision(proposal.id, 'WITHDRAW');
    setShowWithdraw(false);
  };
  const handleLookupContact = () => onLookupContact(proposal.case_id);

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge className={cn("gap-1", actionConfig.color)}>
                {actionConfig.icon}
                {actionConfig.label}
              </Badge>
              {proposal.pause_reason && (
                <Badge variant="outline" className="text-xs">
                  {PAUSE_REASON_LABELS[proposal.pause_reason] || proposal.pause_reason}
                </Badge>
              )}
              <SentimentBadge sentiment={proposal.analysis.sentiment} />
            </div>
            <CardTitle className="text-base">
              <Link
                href={`/requests/detail?id=${proposal.case_id}`}
                className="hover:underline"
              >
                {proposal.case.name || proposal.case.subject_name}
              </Link>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {proposal.case.agency_name}, {proposal.case.state}
            </p>
          </div>

          {/* Fee display */}
          {proposal.analysis.extracted_fee_amount && (
            <div className="text-right">
              <p className="text-lg font-semibold text-amber-400">
                ${proposal.analysis.extracted_fee_amount.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">Fee Amount</p>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Classification & warnings */}
        <div className="flex flex-wrap gap-2">
          {proposal.analysis.classification && (
            <Badge variant="secondary" className="text-xs">
              {proposal.analysis.classification}
            </Badge>
          )}
          {proposal.risk_flags?.map((flag, i) => (
            <Badge key={i} variant="destructive" className="text-xs">
              {flag}
            </Badge>
          ))}
          {proposal.warnings?.map((warning, i) => (
            <Badge key={i} variant="outline" className="text-xs text-amber-400 border-amber-700/50">
              {warning}
            </Badge>
          ))}
        </div>

        {/* Draft preview */}
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-1 text-sm text-primary hover:underline">
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {expanded ? "Hide draft" : "Show draft preview"}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="bg-muted/50 rounded-md p-3 space-y-2">
              {proposal.draft_subject && (
                <p className="text-sm font-medium">
                  Subject: {proposal.draft_subject}
                </p>
              )}
              <pre className="text-xs whitespace-pre-wrap font-sans max-h-48 overflow-auto">
                {proposal.draft_body_text || "No draft content"}
              </pre>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Reasoning */}
        {proposal.reasoning && proposal.reasoning.length > 0 && (() => {
          const allItems = formatReasoning(proposal.reasoning);
          const hasMore = allItems.length > 2;
          return (
            <Collapsible>
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">Reasoning: </span>
                {allItems.slice(0, 2).join(" \u2022 ")}
                {hasMore && (
                  <CollapsibleTrigger asChild>
                    <button className="text-primary hover:underline ml-1">
                      (+{allItems.length - 2} more)
                    </button>
                  </CollapsibleTrigger>
                )}
              </div>
              {hasMore && (
                <CollapsibleContent className="mt-1">
                  <ul className="text-xs text-muted-foreground space-y-0.5 pl-1">
                    {allItems.map((item, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="shrink-0">\u2022</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              )}
            </Collapsible>
          );
        })()}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 border-t">
          <Button
            onClick={handleApprove}
            disabled={isProcessing}
            className="gap-1"
            size="sm"
          >
            {isProcessing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="h-4 w-4" />
            )}
            Approve
          </Button>

          <Button
            onClick={() => setShowAdjust(true)}
            disabled={isProcessing}
            variant="outline"
            size="sm"
            className="gap-1"
          >
            <Edit3 className="h-4 w-4" />
            Adjust
          </Button>

          <Button
            onClick={handleLookupContact}
            disabled={isProcessing || isLookingUpContact}
            variant="outline"
            size="sm"
            className="gap-1"
          >
            {isLookingUpContact ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Research Contacts
          </Button>

          <Button
            onClick={handleDismiss}
            disabled={isProcessing}
            variant="ghost"
            size="sm"
            className="gap-1"
          >
            <XCircle className="h-4 w-4" />
            Dismiss
          </Button>

          <Button
            onClick={() => setShowWithdraw(true)}
            disabled={isProcessing}
            variant="ghost"
            size="sm"
            className="gap-1 text-destructive hover:text-destructive"
          >
            <LogOut className="h-4 w-4" />
            Withdraw
          </Button>

          <div className="ml-auto text-xs text-muted-foreground">
            {new Date(proposal.created_at).toLocaleString()}
          </div>
        </div>
      </CardContent>

      {/* Adjust Dialog */}
      <Dialog open={showAdjust} onOpenChange={setShowAdjust}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Proposal</DialogTitle>
            <DialogDescription>
              Provide instructions for how the draft should be modified.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={adjustInstruction}
            onChange={(e) => setAdjustInstruction(e.target.value)}
            placeholder="e.g., Make the tone more formal, add a reference to statute X, request itemized breakdown..."
            className="min-h-24"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdjust(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdjust} disabled={!adjustInstruction.trim() || isProcessing}>
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit Adjustment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdraw Confirmation Dialog */}
      <Dialog open={showWithdraw} onOpenChange={setShowWithdraw}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw Request</DialogTitle>
            <DialogDescription>
              This will close the entire FOIA request, not just this proposal. Are you sure you want to withdraw?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowWithdraw(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleWithdraw} disabled={isProcessing}>
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Withdraw Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function QueuePage() {
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [researchingCaseId, setResearchingCaseId] = useState<number | null>(null);

  const { data, error, isLoading, mutate } = useSWR<ProposalsListResponse>(
    "/proposals",
    fetcher,
    { refreshInterval: 15000 } // Poll every 15s
  );

  const handleDecision = async (
    proposalId: number,
    action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW',
    instruction?: string
  ) => {
    setProcessingId(proposalId);

    try {
      await proposalsAPI.decide(proposalId, {
        action,
        instruction,
      });

      // Refresh the list
      mutate();
    } catch (err) {
      console.error("Decision failed:", err);
      // Could add toast notification here
    } finally {
      setProcessingId(null);
    }
  };

  const handleLookupContact = async (caseId: number) => {
    setResearchingCaseId(caseId);
    try {
      await fetchAPI(`/monitor/case/${caseId}/lookup-contact`, {
        method: "POST",
        body: JSON.stringify({ forceSearch: true }),
      });
      mutate();
    } catch (err) {
      console.error("Contact lookup failed:", err);
    } finally {
      setResearchingCaseId(null);
    }
  };

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load approval queue</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Approval Queue</h1>
          <p className="text-sm text-muted-foreground">
            Review and approve AI-generated proposals before they are sent
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => mutate()}
          disabled={isLoading}
          className="gap-1"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : !data?.proposals?.length ? (
        <Card className="py-12">
          <div className="text-center">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
            <h2 className="text-lg font-semibold">All caught up!</h2>
            <p className="text-muted-foreground">
              No proposals pending approval right now.
            </p>
          </div>
        </Card>
      ) : (
        <div>
          <p className="text-sm text-muted-foreground mb-4">
            {data.count} proposal{data.count !== 1 ? "s" : ""} pending approval
          </p>

          {data.proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              onDecision={handleDecision}
              onLookupContact={handleLookupContact}
              isProcessing={processingId === proposal.id}
              isLookingUpContact={researchingCaseId === proposal.case_id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
