"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type {
  NextAction,
  RequestDetail,
  AgencySummary,
  PauseReason,
} from "@/lib/types";
import { formatCurrency, formatDate, PAUSE_REASON_LABELS } from "@/lib/utils";
import {
  CheckCircle,
  Edit,
  XCircle,
  AlertCircle,
  DollarSign,
  FileQuestion,
  UserCheck,
  Loader2,
  ExternalLink,
} from "lucide-react";

interface GateReasonActionsProps {
  reason: PauseReason;
  onApprove: () => void;
  onAction: (action: string) => void;
}

function GateReasonActions({ reason, onApprove, onAction }: GateReasonActionsProps) {
  const actions: Record<PauseReason, { primary: string; secondary: string[] }> = {
    FEE_QUOTE: {
      primary: "Approve Fee",
      secondary: ["Negotiate", "Request Itemized"],
    },
    SCOPE: {
      primary: "Accept Scope",
      secondary: ["Counter-propose", "Clarify"],
    },
    DENIAL: {
      primary: "Appeal",
      secondary: ["Revise Request", "Escalate"],
    },
    ID_REQUIRED: {
      primary: "Provide ID",
      secondary: ["Request Waiver"],
    },
    SENSITIVE: {
      primary: "Proceed",
      secondary: ["Modify Request"],
    },
    CLOSE_ACTION: {
      primary: "Complete",
      secondary: ["Continue"],
    },
  };

  const config = actions[reason];

  return (
    <div className="space-y-2">
      <Button onClick={onApprove} className="w-full">
        {config.primary}
      </Button>
      <div className="flex gap-2">
        {config.secondary.map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onAction(action)}
          >
            {action}
          </Button>
        ))}
      </div>
    </div>
  );
}

interface CopilotPanelProps {
  request: RequestDetail;
  nextAction: NextAction | null;
  agency: AgencySummary;
  onApprove: () => Promise<void>;
  onRevise: (instruction: string) => Promise<void>;
  onDismiss: () => Promise<void>;
}

export function CopilotPanel({
  request,
  nextAction,
  agency,
  onApprove,
  onRevise,
  onDismiss,
}: CopilotPanelProps) {
  const [reviseDialogOpen, setReviseDialogOpen] = useState(false);
  const [reviseInstruction, setReviseInstruction] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleApprove = async () => {
    setIsLoading(true);
    try {
      await onApprove();
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevise = async () => {
    if (!reviseInstruction.trim()) return;
    setIsLoading(true);
    try {
      await onRevise(reviseInstruction);
      setReviseDialogOpen(false);
      setReviseInstruction("");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDismiss = async () => {
    setIsLoading(true);
    try {
      await onDismiss();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ScrollArea className="h-[calc(100vh-300px)]">
      <div className="space-y-4 pr-4">
        {/* Next Action Proposal */}
        {nextAction && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-yellow-500" />
                Next Action
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="font-medium text-sm">{nextAction.proposal}</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                {nextAction.reasoning.map((reason, i) => (
                  <li key={i}>• {reason}</li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  Confidence: {Math.round(nextAction.confidence * 100)}%
                </Badge>
                {nextAction.risk_flags.map((flag, i) => (
                  <Badge key={i} variant="destructive" className="text-xs">
                    {flag}
                  </Badge>
                ))}
              </div>
              {nextAction.draft_content && (
                <div className="bg-muted rounded p-2 text-xs max-h-32 overflow-auto">
                  {nextAction.draft_content}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleApprove}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  )}
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReviseDialogOpen(true)}
                  disabled={isLoading}
                >
                  <Edit className="h-3 w-3 mr-1" />
                  Adjust
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleDismiss}
                  disabled={isLoading}
                >
                  <XCircle className="h-3 w-3 mr-1" />
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Gate Reason (if paused) */}
        {request.requires_human && request.pause_reason && (
          <Card className="border-yellow-200 bg-yellow-50 dark:bg-yellow-950 dark:border-yellow-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-yellow-600" />
                Paused: {PAUSE_REASON_LABELS[request.pause_reason]}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <GateReasonActions
                reason={request.pause_reason}
                onApprove={handleApprove}
                onAction={(action) => console.log("Action:", action)}
              />
            </CardContent>
          </Card>
        )}

        <Separator />

        {/* Request Details */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Request Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Scope:</span>
              <p className="font-medium">{request.scope_summary || "—"}</p>
            </div>
            {request.cost_amount && (
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span>
                  {formatCurrency(request.cost_amount)} ({request.cost_status})
                </span>
              </div>
            )}
            {request.incident_date && (
              <div>
                <span className="text-muted-foreground">Incident Date:</span>
                <p>{formatDate(request.incident_date)}</p>
              </div>
            )}
            {request.incident_location && (
              <div>
                <span className="text-muted-foreground">Location:</span>
                <p>{request.incident_location}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Agency Info */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              Agency Profile
              <a
                href={`/dashboard/agencies/${agency.id}`}
                className="text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3 inline mr-1" />
                View
              </a>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="font-medium">{agency.name}</p>
            <p className="text-muted-foreground">{agency.state}</p>
            <Badge variant="outline">{agency.submission_method}</Badge>
            {agency.portal_url && (
              <a
                href={agency.portal_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline block"
              >
                Portal Link
              </a>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Revise Dialog */}
      <Dialog open={reviseDialogOpen} onOpenChange={setReviseDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask AI to Adjust</DialogTitle>
            <DialogDescription>
              Tell the AI how you want to modify the proposed action.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="e.g., Make the tone more formal and mention the statutory deadline"
            value={reviseInstruction}
            onChange={(e) => setReviseInstruction(e.target.value)}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviseDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRevise} disabled={isLoading || !reviseInstruction.trim()}>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Revise
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}
