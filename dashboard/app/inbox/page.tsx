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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fetcher,
  proposalsAPI,
  type ProposalListItem,
  type ProposalsListResponse,
} from "@/lib/api";
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
  Edit,
  Trash2,
  Ban,
  Bot,
  Eye,
  MoreHorizontal,
  Send,
} from "lucide-react";

const ACTION_TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  SEND_EMAIL: { icon: <Mail className="h-4 w-4" />, color: "text-blue-600 bg-blue-50", label: "Send Email" },
  SEND_REPLY: { icon: <Mail className="h-4 w-4" />, color: "text-blue-600 bg-blue-50", label: "Send Reply" },
  ACCEPT_FEE: { icon: <DollarSign className="h-4 w-4" />, color: "text-green-600 bg-green-50", label: "Accept Fee" },
  NEGOTIATE_FEE: { icon: <DollarSign className="h-4 w-4" />, color: "text-amber-600 bg-amber-50", label: "Negotiate Fee" },
  APPEAL: { icon: <FileQuestion className="h-4 w-4" />, color: "text-orange-600 bg-orange-50", label: "Appeal" },
  NARROW_SCOPE: { icon: <FileQuestion className="h-4 w-4" />, color: "text-purple-600 bg-purple-50", label: "Narrow Scope" },
  FOLLOW_UP: { icon: <Clock className="h-4 w-4" />, color: "text-gray-600 bg-gray-50", label: "Follow Up" },
  WITHDRAW: { icon: <Ban className="h-4 w-4" />, color: "text-red-600 bg-red-50", label: "Withdraw" },
};

const PAUSE_REASON_CONFIG: Record<string, { label: string; color: string }> = {
  FEE_QUOTE: { label: "Fee Quote", color: "bg-amber-100 text-amber-800" },
  DENIAL: { label: "Denial", color: "bg-red-100 text-red-800" },
  SCOPE: { label: "Scope", color: "bg-orange-100 text-orange-800" },
  ID_REQUIRED: { label: "ID Required", color: "bg-blue-100 text-blue-800" },
  SENSITIVE: { label: "Sensitive", color: "bg-purple-100 text-purple-800" },
  CLOSE_ACTION: { label: "Close", color: "bg-green-100 text-green-800" },
};

export default function InboxPage() {
  const [selectedProposal, setSelectedProposal] = useState<ProposalListItem | null>(null);
  const [editedDraft, setEditedDraft] = useState("");
  const [adjustInstruction, setAdjustInstruction] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<ProposalsListResponse>(
    "/proposals",
    fetcher,
    { refreshInterval: 15000 }
  );

  const handleSelectProposal = (proposal: ProposalListItem) => {
    setSelectedProposal(proposal);
    setEditedDraft(proposal.draft_body_text || "");
    setAdjustInstruction("");
  };

  const handleDecision = async (action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW') => {
    if (!selectedProposal) return;
    setIsSubmitting(true);

    try {
      await proposalsAPI.decide(selectedProposal.id, {
        action,
        instruction: action === 'ADJUST' ? adjustInstruction : undefined,
        reason: action === 'DISMISS' || action === 'WITHDRAW' ? 'User decision' : undefined,
      });

      mutate();
      setSelectedProposal(null);
      setShowAdjustModal(false);
    } catch (error) {
      console.error("Error submitting decision:", error);
      alert("Failed to submit decision");
    } finally {
      setIsSubmitting(false);
    }
  };

  const proposals = data?.proposals || [];

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
            <Bot className="h-6 w-6" />
            Approval Inbox
          </h1>
          <p className="text-sm text-muted-foreground">
            Review and approve pending agent proposals
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-lg px-3 py-1">
            {proposals.length} pending
          </Badge>
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : proposals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" />
            <h3 className="text-lg font-semibold">All caught up!</h3>
            <p className="text-muted-foreground">No proposals awaiting approval</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Proposals List */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pending Proposals</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[600px]">
                <div className="divide-y">
                  {proposals.map((proposal) => {
                    const actionConfig = ACTION_TYPE_CONFIG[proposal.action_type] || {
                      icon: <Mail className="h-4 w-4" />,
                      color: "text-gray-600 bg-gray-50",
                      label: proposal.action_type,
                    };
                    const pauseConfig = proposal.pause_reason
                      ? PAUSE_REASON_CONFIG[proposal.pause_reason]
                      : null;

                    return (
                      <div
                        key={proposal.id}
                        className={cn(
                          "p-4 cursor-pointer hover:bg-muted/50 transition-colors",
                          selectedProposal?.id === proposal.id && "bg-muted"
                        )}
                        onClick={() => handleSelectProposal(proposal)}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">
                              {proposal.case.subject_name || proposal.case.name}
                            </p>
                            <p className="text-sm text-muted-foreground truncate">
                              {proposal.case.agency_name}
                            </p>
                          </div>
                          <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant="outline"
                            className={cn("gap-1 text-xs", actionConfig.color)}
                          >
                            {actionConfig.icon}
                            {actionConfig.label}
                          </Badge>

                          {pauseConfig && (
                            <Badge className={cn("text-xs", pauseConfig.color)}>
                              {pauseConfig.label}
                            </Badge>
                          )}

                          {proposal.confidence && (
                            <Badge variant="outline" className="text-xs">
                              {Math.round(proposal.confidence * 100)}% conf
                            </Badge>
                          )}

                          {proposal.analysis.extracted_fee_amount && (
                            <Badge variant="outline" className="text-xs text-green-600">
                              ${proposal.analysis.extracted_fee_amount}
                            </Badge>
                          )}
                        </div>

                        <p className="text-xs text-muted-foreground mt-2">
                          {formatDate(proposal.created_at)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Proposal Detail */}
          <Card className="lg:col-span-1">
            {selectedProposal ? (
              <>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Proposal Details</CardTitle>
                    <Link
                      href={`/requests/detail?id=${selectedProposal.case_id}`}
                      className="text-sm text-primary hover:underline"
                    >
                      View Case
                    </Link>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Case Info */}
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="font-medium">{selectedProposal.case.subject_name}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedProposal.case.agency_name} • {selectedProposal.case.state}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="outline" className="text-xs">
                        {selectedProposal.case.autopilot_mode}
                      </Badge>
                      {selectedProposal.analysis.classification && (
                        <Badge variant="outline" className="text-xs">
                          {selectedProposal.analysis.classification}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Reasoning */}
                  {selectedProposal.reasoning && selectedProposal.reasoning.length > 0 && (
                    <div>
                      <p className="text-sm font-medium mb-2">AI Reasoning:</p>
                      <ul className="text-sm space-y-1">
                        {selectedProposal.reasoning.map((r, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-muted-foreground">•</span>
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Warnings */}
                  {selectedProposal.warnings && selectedProposal.warnings.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <p className="text-sm font-medium text-amber-700 flex items-center gap-1 mb-2">
                        <AlertTriangle className="h-4 w-4" />
                        Warnings
                      </p>
                      <ul className="text-sm text-amber-600 space-y-1">
                        {selectedProposal.warnings.map((w, i) => (
                          <li key={i}>• {w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Separator />

                  {/* Draft Content */}
                  <div>
                    <p className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Draft Response
                    </p>
                    {selectedProposal.draft_subject && (
                      <p className="text-sm mb-2">
                        <span className="text-muted-foreground">Subject:</span>{" "}
                        {selectedProposal.draft_subject}
                      </p>
                    )}
                    <Textarea
                      value={editedDraft}
                      onChange={(e) => setEditedDraft(e.target.value)}
                      className="min-h-[200px] font-mono text-sm"
                    />
                  </div>

                  <Separator />

                  {/* Actions */}
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        onClick={() => handleDecision('APPROVE')}
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4 mr-1" />
                        )}
                        Approve & Execute
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setShowAdjustModal(true)}
                        disabled={isSubmitting}
                      >
                        <Edit className="h-4 w-4 mr-1" />
                        Adjust
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => handleDecision('DISMISS')}
                        disabled={isSubmitting}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Dismiss
                      </Button>
                      <Button
                        variant="destructive"
                        className="flex-1"
                        onClick={() => handleDecision('WITHDRAW')}
                        disabled={isSubmitting}
                      >
                        <Ban className="h-4 w-4 mr-1" />
                        Withdraw Case
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </>
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

      {/* Adjust Modal */}
      <Dialog open={showAdjustModal} onOpenChange={setShowAdjustModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Proposal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Provide instructions for how the AI should adjust this proposal:
            </p>
            <Textarea
              placeholder="e.g., Make the tone more formal, add a reference to the statute..."
              value={adjustInstruction}
              onChange={(e) => setAdjustInstruction(e.target.value)}
              className="min-h-[100px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdjustModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => handleDecision('ADJUST')}
              disabled={!adjustInstruction.trim() || isSubmitting}
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Edit className="h-4 w-4 mr-1" />
              )}
              Adjust & Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
