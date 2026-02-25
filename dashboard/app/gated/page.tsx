"use client";

import { useState, useMemo, useEffect } from "react";
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
  fetcher,
  runsAPI,
  proposalsAPI,
  type AgentRun,
  type ProposalListItem,
} from "@/lib/api";
import { formatDate, cn } from "@/lib/utils";
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
  Zap,
  RotateCcw,
  XCircle,
} from "lucide-react";

const PAUSE_REASON_LABELS: Record<string, string> = {
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

export default function GatedInboxPage() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [adjustInstruction, setAdjustInstruction] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);

  const { data: runsData, error, isLoading, mutate } = useSWR<{ success: boolean; runs: AgentRun[] }>(
    "/runs?status=gated&limit=100",
    fetcher,
    { refreshInterval: 15000 }
  );

  const runs = useMemo(() => {
    const all = runsData?.runs || [];
    // Real runs first, then simulated
    return all.sort((a, b) => {
      const aIsSim = a.trigger_type?.toLowerCase().includes("simulated") || a.trigger_type?.toLowerCase().includes("test");
      const bIsSim = b.trigger_type?.toLowerCase().includes("simulated") || b.trigger_type?.toLowerCase().includes("test");
      if (aIsSim && !bIsSim) return 1;
      if (!aIsSim && bIsSim) return -1;
      return 0;
    });
  }, [runsData]);

  const selectedRun = runs[currentIndex] || null;

  // Fetch proposal for current run
  const { data: proposalData } = useSWR<{ success: boolean; proposal: ProposalListItem }>(
    selectedRun?.proposal_id ? `/proposals/${selectedRun.proposal_id}` : null,
    fetcher
  );
  const proposal = proposalData?.proposal || null;

  // Keyboard nav
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showAdjustModal || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); navigate(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); navigate(1); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentIndex, runs.length, showAdjustModal]);

  const navigate = (delta: number) => {
    if (runs.length === 0) return;
    setCurrentIndex((prev) => {
      const next = prev + delta;
      if (next < 0) return runs.length - 1;
      if (next >= runs.length) return 0;
      return next;
    });
  };

  const handleDecision = async (action: "APPROVE" | "ADJUST" | "DISMISS" | "WITHDRAW") => {
    if (!selectedRun?.proposal_id) return;
    setIsSubmitting(true);
    try {
      await proposalsAPI.decide(parseInt(selectedRun.proposal_id), {
        action,
        instruction: action === "ADJUST" ? adjustInstruction : undefined,
        reason: action === "DISMISS" || action === "WITHDRAW" ? "User decision" : undefined,
      });
      mutate();
      setShowAdjustModal(false);
      setAdjustInstruction("");
      // Stay at same index (list shrinks, next item slides in)
      if (currentIndex >= runs.length - 1 && currentIndex > 0) {
        setCurrentIndex(currentIndex - 1);
      }
    } catch (err) {
      console.error("Decision failed:", err);
      alert("Failed to submit decision");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelRun = async () => {
    if (!selectedRun || !confirm("Cancel this run?")) return;
    setIsSubmitting(true);
    try {
      await runsAPI.cancel(selectedRun.id, "Cancelled from queue");
      mutate();
    } catch (err) {
      console.error("Cancel failed:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRetryRun = async () => {
    if (!selectedRun) return;
    setIsSubmitting(true);
    try {
      await runsAPI.retry(selectedRun.id);
      mutate();
    } catch (err) {
      console.error("Retry failed:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Loading state
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

  // Empty state
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[80vh] gap-4">
        <CheckCircle className="h-8 w-8 text-green-500" />
        <p className="text-sm text-muted-foreground">Queue empty. No items need attention.</p>
        <Button variant="outline" size="sm" onClick={() => mutate()}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Top bar: counter + nav */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Queue</span>
          <Badge variant="outline" className="text-xs tabular-nums">
            {currentIndex + 1} / {runs.length}
          </Badge>
          <Badge variant="destructive" className="text-xs">
            <Zap className="h-3 w-3 mr-1" /> LIVE
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} title="Previous (←)">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate(1)} title="Next (→)">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <div className="w-px h-4 bg-border mx-1" />
          <Button variant="ghost" size="sm" onClick={() => mutate()}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Case header */}
      <div className="border-b pb-3 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">
              {selectedRun.case_name || `Case #${selectedRun.case_id}`}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                Run #{typeof selectedRun.id === 'string' ? selectedRun.id.slice(0, 8) : selectedRun.id}
              </span>
              <span className="text-xs text-muted-foreground">|</span>
              <span className="text-xs text-muted-foreground">{selectedRun.trigger_type}</span>
              {selectedRun.pause_reason && (
                <Badge variant="outline" className="text-[10px]">
                  {PAUSE_REASON_LABELS[selectedRun.pause_reason] || selectedRun.pause_reason}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/requests/detail?id=${selectedRun.case_id}`}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" /> Case
            </Link>
            <Button variant="ghost" size="sm" onClick={handleRetryRun} disabled={isSubmitting} title="Retry">
              <RotateCcw className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancelRun} disabled={isSubmitting} title="Cancel run">
              <XCircle className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* Proposal content */}
      {!proposal && selectedRun.proposal_id && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!proposal && !selectedRun.proposal_id && (
        <div className="text-center py-12">
          <AlertTriangle className="h-6 w-6 mx-auto text-amber-500 mb-2" />
          <p className="text-xs text-muted-foreground">No proposal for this run</p>
          <div className="flex gap-2 justify-center mt-3">
            <Button variant="outline" size="sm" onClick={handleRetryRun} disabled={isSubmitting}>
              <RotateCcw className="h-3 w-3 mr-1" /> Retry
            </Button>
            <Button variant="outline" size="sm" onClick={handleCancelRun} disabled={isSubmitting}>
              <XCircle className="h-3 w-3 mr-1" /> Cancel
            </Button>
          </div>
        </div>
      )}

      {proposal && (
        <div className="space-y-4">
          {/* Proposed action */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground uppercase tracking-wider">Action:</span>
            <Badge variant="outline" className="text-xs">
              {proposal.action_type}
            </Badge>
            {proposal.confidence != null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(proposal.confidence * 100)}%
              </span>
            )}
          </div>

          {/* Risk flags */}
          {proposal.risk_flags && proposal.risk_flags.length > 0 && (
            <div className="border border-amber-700/50 bg-amber-950/20 p-3">
              <p className="text-xs font-semibold text-amber-400 flex items-center gap-1 mb-1">
                <AlertTriangle className="h-3 w-3" /> RISK FLAGS
              </p>
              <div className="flex flex-wrap gap-1">
                {proposal.risk_flags.map((flag, i) => (
                  <Badge key={i} variant="outline" className="text-[10px] text-amber-400 border-amber-700/50">
                    {flag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Warnings */}
          {proposal.warnings && proposal.warnings.length > 0 && (
            <div className="border border-orange-700/50 bg-orange-950/20 p-3">
              <p className="text-xs font-semibold text-orange-400 mb-1">WARNINGS</p>
              {proposal.warnings.map((w, i) => (
                <p key={i} className="text-xs text-orange-300">- {w}</p>
              ))}
            </div>
          )}

          {/* AI reasoning */}
          {proposal.reasoning && proposal.reasoning.length > 0 && (
            <div className="border p-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Reasoning</p>
              {proposal.reasoning.map((r, i) => (
                <p key={i} className="text-xs text-foreground/80 mb-1">
                  <span className="text-muted-foreground mr-1">{i + 1}.</span>
                  {typeof r === "string" ? r : JSON.stringify(r)}
                </p>
              ))}
            </div>
          )}

          {/* Inbound message (what agency sent) */}
          {selectedRun.trigger_message && (
            <div className="border p-3">
              <div className="flex items-center gap-2 mb-2">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Inbound</p>
                {selectedRun.trigger_message.classification && (
                  <Badge variant="outline" className="text-[10px]">
                    {selectedRun.trigger_message.classification}
                  </Badge>
                )}
                {selectedRun.trigger_message.sentiment && (
                  <Badge variant="outline" className={cn(
                    "text-[10px]",
                    selectedRun.trigger_message.sentiment === "HOSTILE" && "text-red-400 border-red-700/50"
                  )}>
                    {selectedRun.trigger_message.sentiment}
                  </Badge>
                )}
              </div>
              {selectedRun.trigger_message.from_email && (
                <p className="text-xs text-muted-foreground mb-1">
                  From: {selectedRun.trigger_message.from_email}
                </p>
              )}
              {selectedRun.trigger_message.subject && (
                <p className="text-xs mb-2">
                  <span className="text-muted-foreground">Subj:</span> {selectedRun.trigger_message.subject}
                </p>
              )}
              <div className="bg-background border p-2 max-h-48 overflow-auto">
                <pre className="text-xs whitespace-pre-wrap font-[inherit]">
                  {selectedRun.trigger_message.body_text || "(empty)"}
                </pre>
              </div>
            </div>
          )}

          {/* Draft response */}
          <div className="border p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Draft Response</p>
            {proposal.draft_subject && (
              <p className="text-xs mb-2">
                <span className="text-muted-foreground">Subj:</span> {proposal.draft_subject}
              </p>
            )}
            <div className="bg-background border p-2 max-h-64 overflow-auto">
              <pre className="text-xs whitespace-pre-wrap font-[inherit]">
                {proposal.draft_body_text || "(no draft)"}
              </pre>
            </div>
          </div>

          {/* Action buttons */}
          <div className="border-t pt-4 space-y-2">
            <div className="flex gap-2">
              <Button
                className="flex-1 bg-green-700 hover:bg-green-600 text-white"
                onClick={() => handleDecision("APPROVE")}
                disabled={isSubmitting}
              >
                {isSubmitting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                APPROVE & EXECUTE
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
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => handleDecision("DISMISS")}
                disabled={isSubmitting}
              >
                <Trash2 className="h-3 w-3 mr-1" /> DISMISS
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={() => handleDecision("WITHDRAW")}
                disabled={isSubmitting}
              >
                <Ban className="h-3 w-3 mr-1" /> WITHDRAW
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Adjust modal */}
      <Dialog open={showAdjustModal} onOpenChange={setShowAdjustModal}>
        <DialogContent className="bg-card border">
          <DialogHeader>
            <DialogTitle className="text-sm">Adjust Proposal</DialogTitle>
            <DialogDescription className="text-xs">
              Provide instructions for the AI to regenerate this draft
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., Make tone more formal, reference the statute..."
            value={adjustInstruction}
            onChange={(e) => setAdjustInstruction(e.target.value)}
            className="min-h-[80px] text-xs bg-background"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAdjustModal(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => handleDecision("ADJUST")}
              disabled={!adjustInstruction.trim() || isSubmitting}
            >
              {isSubmitting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Edit className="h-3 w-3 mr-1" />}
              Adjust
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
