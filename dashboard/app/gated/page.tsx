"use client";

import { useState, useMemo, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  XCircle,
  AlertTriangle,
  Clock,
  Mail,
  DollarSign,
  FileQuestion,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Edit,
  Trash2,
  Ban,
  Play,
  Eye,
  MoreHorizontal,
  Send,
  ExternalLink,
  UserCheck,
  Shield,
  Zap,
  FlaskConical,
  RotateCcw,
  Activity,
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
  SCOPE: { label: "Scope Issue", color: "bg-orange-100 text-orange-800" },
  ID_REQUIRED: { label: "ID Required", color: "bg-blue-100 text-blue-800" },
  SENSITIVE: { label: "Sensitive Content", color: "bg-purple-100 text-purple-800" },
  CLOSE_ACTION: { label: "Close Action", color: "bg-green-100 text-green-800" },
  PORTAL: { label: "Portal Required", color: "bg-cyan-100 text-cyan-800" },
  HOSTILE_SENTIMENT: { label: "Hostile Sentiment", color: "bg-red-100 text-red-800" },
  STRONG_DENIAL: { label: "Strong Denial", color: "bg-red-200 text-red-900" },
  HIGH_FEE: { label: "High Fee", color: "bg-amber-200 text-amber-900" },
  SUPERVISED_MODE: { label: "Supervised Mode", color: "bg-slate-100 text-slate-800" },
};

interface EnvironmentStatus {
  shadow_mode: boolean;
  execution_mode: "DRY" | "LIVE";
  is_shadow: boolean;
}

export default function GatedInboxPage() {
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null);
  const [selectedProposal, setSelectedProposal] = useState<ProposalListItem | null>(null);
  const [adjustInstruction, setAdjustInstruction] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdjustModal, setShowAdjustModal] = useState(false);

  // Fetch gated runs
  const { data: runsData, error, isLoading, mutate } = useSWR<{ success: boolean; runs: AgentRun[] }>(
    "/runs?status=gated&limit=100",
    fetcher,
    { refreshInterval: 15000 }
  );

  // Fetch environment status
  const { data: envData } = useSWR<EnvironmentStatus>(
    "/shadow/status",
    fetcher
  );

  // Fetch proposal details when a run is selected
  const { data: proposalData, mutate: mutateProposal } = useSWR<{ success: boolean; proposal: ProposalListItem }>(
    selectedRun?.proposal_id ? `/proposals/${selectedRun.proposal_id}` : null,
    fetcher
  );

  const handleSelectRun = async (run: AgentRun) => {
    setSelectedRun(run);
    setSelectedProposal(null);
    setAdjustInstruction("");
  };

  const gatedRuns = runsData?.runs || [];

  // Separate simulated from real runs
  const { realRuns, simRuns } = useMemo(() => {
    const real: AgentRun[] = [];
    const sim: AgentRun[] = [];
    gatedRuns.forEach(run => {
      if (run.trigger_type?.toLowerCase().includes('simulated') ||
          run.trigger_type?.toLowerCase().includes('test')) {
        sim.push(run);
      } else {
        real.push(run);
      }
    });
    return { realRuns: real, simRuns: sim };
  }, [gatedRuns]);

  // Queue navigation - combine real runs first, then sim runs
  const allOrderedRuns = useMemo(() => [...realRuns, ...simRuns], [realRuns, simRuns]);

  const currentIndex = useMemo(() => {
    if (!selectedRun) return -1;
    return allOrderedRuns.findIndex(r => r.id === selectedRun.id);
  }, [selectedRun, allOrderedRuns]);

  const handleNavigate = (direction: 'prev' | 'next') => {
    if (currentIndex === -1 || allOrderedRuns.length === 0) return;

    let newIndex: number;
    if (direction === 'prev') {
      newIndex = currentIndex > 0 ? currentIndex - 1 : allOrderedRuns.length - 1;
    } else {
      newIndex = currentIndex < allOrderedRuns.length - 1 ? currentIndex + 1 : 0;
    }

    const newRun = allOrderedRuns[newIndex];
    handleSelectRun(newRun);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't navigate if typing in an input/textarea or modal is open
      if (
        showAdjustModal ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleNavigate('prev');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNavigate('next');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, allOrderedRuns, showAdjustModal]);

  // Auto-select first run when list loads or changes
  useEffect(() => {
    if (!selectedRun && allOrderedRuns.length > 0) {
      handleSelectRun(allOrderedRuns[0]);
    }
  }, [allOrderedRuns.length]);

  const handleDecision = async (action: 'APPROVE' | 'ADJUST' | 'DISMISS' | 'WITHDRAW') => {
    if (!selectedRun?.proposal_id) return;
    setIsSubmitting(true);

    try {
      await proposalsAPI.decide(parseInt(selectedRun.proposal_id), {
        action,
        instruction: action === 'ADJUST' ? adjustInstruction : undefined,
        reason: action === 'DISMISS' || action === 'WITHDRAW' ? 'User decision' : undefined,
      });

      mutate();
      setSelectedRun(null);
      setShowAdjustModal(false);
    } catch (error) {
      console.error("Error submitting decision:", error);
      alert("Failed to submit decision");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelRun = async (run: AgentRun) => {
    if (!confirm("Are you sure you want to cancel this run?")) return;
    setIsSubmitting(true);
    try {
      await runsAPI.cancel(run.id, "Cancelled from gated inbox");
      mutate();
      if (selectedRun?.id === run.id) {
        setSelectedRun(null);
      }
    } catch (error) {
      console.error("Error cancelling run:", error);
      alert("Failed to cancel run");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRetryRun = async (run: AgentRun) => {
    setIsSubmitting(true);
    try {
      await runsAPI.retry(run.id);
      mutate();
    } catch (error) {
      console.error("Error retrying run:", error);
      alert("Failed to retry run");
    } finally {
      setIsSubmitting(false);
    }
  };

  const proposal = proposalData?.proposal || null;

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-destructive">Failed to load gated runs</p>
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
            <Shield className="h-6 w-6" />
            Gated Inbox
          </h1>
          <p className="text-sm text-muted-foreground">
            Runs awaiting human approval before execution
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Environment indicator */}
          {envData && (
            <Badge
              variant="outline"
              className={cn(
                "text-sm px-3 py-1",
                envData.execution_mode === "LIVE"
                  ? "border-red-500 text-red-600 bg-red-50"
                  : "border-blue-500 text-blue-600 bg-blue-50"
              )}
            >
              {envData.execution_mode === "LIVE" ? (
                <Zap className="h-3 w-3 mr-1" />
              ) : (
                <FlaskConical className="h-3 w-3 mr-1" />
              )}
              {envData.execution_mode}
            </Badge>
          )}
          <Badge variant="outline" className="text-lg px-3 py-1">
            {realRuns.length} pending
          </Badge>
          {simRuns.length > 0 && (
            <Badge variant="secondary" className="text-sm px-2 py-1">
              {simRuns.length} simulated
            </Badge>
          )}
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
      ) : gatedRuns.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle className="h-12 w-12 mx-auto text-green-500 mb-4" />
            <h3 className="text-lg font-semibold">All caught up!</h3>
            <p className="text-muted-foreground">No runs awaiting approval</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Runs List */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pending Approval</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[600px]">
                <div className="divide-y">
                  {/* Real runs first */}
                  {realRuns.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      isSelected={selectedRun?.id === run.id}
                      isSimulated={false}
                      onSelect={() => handleSelectRun(run)}
                      onCancel={() => handleCancelRun(run)}
                      onRetry={() => handleRetryRun(run)}
                    />
                  ))}

                  {/* Separator if both types exist */}
                  {realRuns.length > 0 && simRuns.length > 0 && (
                    <div className="px-4 py-2 bg-muted/50">
                      <span className="text-xs text-muted-foreground font-medium">
                        Simulated / Test Runs
                      </span>
                    </div>
                  )}

                  {/* Simulated runs */}
                  {simRuns.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      isSelected={selectedRun?.id === run.id}
                      isSimulated={true}
                      onSelect={() => handleSelectRun(run)}
                      onCancel={() => handleCancelRun(run)}
                      onRetry={() => handleRetryRun(run)}
                    />
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Proposal Detail */}
          <Card className="lg:col-span-1">
            {selectedRun ? (
              <>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-base">Proposal Review</CardTitle>
                      {/* Queue navigation */}
                      {allOrderedRuns.length > 1 && currentIndex !== -1 && (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleNavigate('prev')}
                            title="Previous (use ← key)"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <Badge variant="secondary" className="text-xs px-2">
                            {currentIndex + 1} of {allOrderedRuns.length}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleNavigate('next')}
                            title="Next (use → key)"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/requests/detail?id=${selectedRun.case_id}`}
                        className="text-sm text-primary hover:underline"
                      >
                        View Case
                      </Link>
                      <Link
                        href={`/runs?id=${selectedRun.id}`}
                        className="text-sm text-muted-foreground hover:underline"
                      >
                        Run Trace
                      </Link>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Execution Mode Warning */}
                  {envData && (
                    <div
                      className={cn(
                        "p-3 rounded-lg border flex items-center gap-2",
                        envData.execution_mode === "LIVE"
                          ? "bg-red-50 border-red-200 text-red-700"
                          : "bg-blue-50 border-blue-200 text-blue-700"
                      )}
                    >
                      {envData.execution_mode === "LIVE" ? (
                        <>
                          <Zap className="h-4 w-4" />
                          <span className="text-sm font-medium">
                            LIVE MODE - Approval will trigger real execution
                          </span>
                        </>
                      ) : (
                        <>
                          <FlaskConical className="h-4 w-4" />
                          <span className="text-sm font-medium">
                            DRY MODE - No actual execution will occur
                          </span>
                        </>
                      )}
                    </div>
                  )}

                  {/* Case Info */}
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="font-medium">{selectedRun.case_name || `Case #${selectedRun.case_id}`}</p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <Badge variant="outline" className="text-xs">
                        {selectedRun.trigger_type}
                      </Badge>
                      {selectedRun.pause_reason && (
                        <Badge className={cn("text-xs", PAUSE_REASON_CONFIG[selectedRun.pause_reason]?.color)}>
                          {PAUSE_REASON_CONFIG[selectedRun.pause_reason]?.label || selectedRun.pause_reason}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Proposal Loading or Display */}
                  {!proposal && selectedRun.proposal_id && (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  )}

                  {proposal && (
                    <>
                      {/* Action Type */}
                      <div>
                        <p className="text-sm font-medium mb-2">Proposed Action:</p>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn(
                              "gap-1",
                              ACTION_TYPE_CONFIG[proposal.action_type]?.color || "bg-gray-50"
                            )}
                          >
                            {ACTION_TYPE_CONFIG[proposal.action_type]?.icon || <Mail className="h-4 w-4" />}
                            {ACTION_TYPE_CONFIG[proposal.action_type]?.label || proposal.action_type}
                          </Badge>
                          {proposal.confidence && (
                            <Badge variant="outline" className="text-xs">
                              {Math.round(proposal.confidence * 100)}% confidence
                            </Badge>
                          )}
                        </div>
                      </div>

                      {/* Risk Flags */}
                      {proposal.risk_flags && proposal.risk_flags.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                          <p className="text-sm font-medium text-amber-700 flex items-center gap-1 mb-2">
                            <AlertTriangle className="h-4 w-4" />
                            Risk Flags
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {proposal.risk_flags.map((flag, i) => (
                              <Badge key={i} variant="outline" className="text-xs text-amber-600">
                                {flag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Warnings */}
                      {proposal.warnings && proposal.warnings.length > 0 && (
                        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                          <p className="text-sm font-medium text-orange-700 mb-2">Warnings:</p>
                          <ul className="text-sm text-orange-600 space-y-1">
                            {proposal.warnings.map((w, i) => (
                              <li key={i}>• {w}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Reasoning */}
                      {proposal.reasoning && proposal.reasoning.length > 0 && (
                        <div>
                          <p className="text-sm font-medium mb-2">AI Reasoning:</p>
                          <ul className="text-sm space-y-1">
                            {proposal.reasoning.map((r, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <span className="text-muted-foreground">•</span>
                                <span>{r}</span>
                              </li>
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
                        {proposal.draft_subject && (
                          <p className="text-sm mb-2">
                            <span className="text-muted-foreground">Subject:</span>{" "}
                            {proposal.draft_subject}
                          </p>
                        )}
                        <div className="bg-muted/50 rounded-lg p-3 max-h-[200px] overflow-auto">
                          <pre className="text-sm whitespace-pre-wrap font-sans">
                            {proposal.draft_body_text || "(No content)"}
                          </pre>
                        </div>
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
                            Edit & Approve
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
                    </>
                  )}

                  {/* No proposal available */}
                  {!proposal && !selectedRun.proposal_id && (
                    <div className="text-center py-8">
                      <AlertTriangle className="h-8 w-8 mx-auto text-amber-500 mb-2" />
                      <p className="text-sm text-muted-foreground">
                        No proposal associated with this run
                      </p>
                      <div className="flex gap-2 justify-center mt-4">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRetryRun(selectedRun)}
                          disabled={isSubmitting}
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Retry Run
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCancelRun(selectedRun)}
                          disabled={isSubmitting}
                        >
                          <XCircle className="h-4 w-4 mr-1" />
                          Cancel Run
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </>
            ) : (
              <CardContent className="py-12 text-center">
                <Eye className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">
                  Select a run to review its proposal
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
            <DialogTitle>Edit Proposal</DialogTitle>
            <DialogDescription>
              Provide instructions for how the AI should adjust this proposal
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
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

// Extracted run row component
function RunRow({
  run,
  isSelected,
  isSimulated,
  onSelect,
  onCancel,
  onRetry,
}: {
  run: AgentRun;
  isSelected: boolean;
  isSimulated: boolean;
  onSelect: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const actionConfig = run.proposal?.action_type
    ? ACTION_TYPE_CONFIG[run.proposal.action_type]
    : null;
  const pauseConfig = run.pause_reason
    ? PAUSE_REASON_CONFIG[run.pause_reason]
    : null;

  return (
    <div
      className={cn(
        "p-4 cursor-pointer hover:bg-muted/50 transition-colors",
        isSelected && "bg-muted",
        isSimulated && "opacity-60"
      )}
      onClick={onSelect}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium truncate">
              {run.case_name || `Case #${run.case_id}`}
            </p>
            {isSimulated && (
              <Badge variant="secondary" className="text-xs">
                SIM
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate">
            Run #{run.id.slice(0, 8)} • {run.trigger_type}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/requests/detail?id=${run.case_id}`}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open Case
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRetry(); }}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Retry Run
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); onCancel(); }}
                className="text-red-600"
              >
                <XCircle className="h-4 w-4 mr-2" />
                Cancel Run
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {actionConfig && (
          <Badge
            variant="outline"
            className={cn("gap-1 text-xs", actionConfig.color)}
          >
            {actionConfig.icon}
            {actionConfig.label}
          </Badge>
        )}

        {pauseConfig && (
          <Badge className={cn("text-xs", pauseConfig.color)}>
            {pauseConfig.label}
          </Badge>
        )}

        {run.proposal?.confidence && (
          <Badge variant="outline" className="text-xs">
            {Math.round(run.proposal.confidence * 100)}% conf
          </Badge>
        )}

        {run.is_stuck && (
          <Badge variant="destructive" className="text-xs">
            Possibly stuck
          </Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground mt-2">
        Started: {formatDate(run.started_at)}
        {run.duration_seconds && run.duration_seconds > 60 && (
          <span className="ml-2">
            ({Math.round(run.duration_seconds / 60)}m elapsed)
          </span>
        )}
      </p>
    </div>
  );
}
