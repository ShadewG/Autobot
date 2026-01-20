"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DecisionPanel } from "./decision-panel";
import { ConstraintsDisplay } from "./constraints-display";
import { ScopeBreakdown } from "./scope-breakdown";
import { AdjustModal } from "./adjust-modal";
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
  AlertTriangle,
  DollarSign,
  Loader2,
  ExternalLink,
  Eye,
  Info,
} from "lucide-react";

interface CopilotPanelProps {
  request: RequestDetail;
  nextAction: NextAction | null;
  agency: AgencySummary;
  onApprove: () => Promise<void>;
  onRevise: (instruction: string) => Promise<void>;
  onDismiss: () => Promise<void>;
  onDecision?: (decision: string, params?: Record<string, unknown>) => Promise<void>;
}

export function CopilotPanel({
  request,
  nextAction,
  agency,
  onApprove,
  onRevise,
  onDismiss,
  onDecision,
}: CopilotPanelProps) {
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleApprove = async () => {
    setIsLoading(true);
    try {
      await onApprove();
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevise = async (instruction: string) => {
    setIsLoading(true);
    try {
      await onRevise(instruction);
      setAdjustModalOpen(false);
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

  const handleDecision = async (decision: string, params?: Record<string, unknown>) => {
    if (onDecision) {
      setIsLoading(true);
      try {
        await onDecision(decision, params);
      } finally {
        setIsLoading(false);
      }
    }
  };

  // Determine button text based on action type
  const getApproveButtonText = () => {
    if (!nextAction) return "Approve & Send";
    const actionLabel = nextAction.proposal_short || nextAction.proposal.split('.')[0];
    return `Approve & Send: ${actionLabel}`;
  };

  return (
    <ScrollArea className="h-[calc(100vh-300px)]">
      <div className="space-y-4 pr-4">
        {/* Decision Panel (if paused) */}
        {request.requires_human && request.pause_reason && (
          <DecisionPanel
            pauseReason={request.pause_reason}
            feeQuote={request.fee_quote}
            agencyRules={agency.rules}
            onDecision={handleDecision}
            isLoading={isLoading}
          />
        )}

        {/* Constraints detected */}
        {request.constraints && request.constraints.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Constraints Detected</CardTitle>
            </CardHeader>
            <CardContent>
              <ConstraintsDisplay constraints={request.constraints} />
            </CardContent>
          </Card>
        )}

        {/* Next Action Proposal */}
        {nextAction && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
                Proposed Action
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="font-medium text-sm">{nextAction.proposal}</p>

              {/* Reasoning */}
              <ul className="text-xs text-muted-foreground space-y-1">
                {nextAction.reasoning.map((reason, i) => (
                  <li key={i}>• {reason}</li>
                ))}
              </ul>

              {/* Constraints applied */}
              {nextAction.constraints_applied && nextAction.constraints_applied.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="text-xs text-muted-foreground">Constraints applied:</span>
                  {nextAction.constraints_applied.map((c, i) => (
                    <Badge key={i} variant="outline" className="text-[10px]">
                      {c}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Confidence and flags */}
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-xs">
                  Confidence: {Math.round(nextAction.confidence * 100)}%
                </Badge>
                {nextAction.risk_flags.map((flag, i) => (
                  <Badge key={i} variant="destructive" className="text-xs">
                    {flag}
                  </Badge>
                ))}
              </div>

              {/* Warnings */}
              {nextAction.warnings && nextAction.warnings.length > 0 && (
                <div className="bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-lg p-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                    <div className="text-xs">
                      <p className="font-medium text-yellow-800 dark:text-yellow-200">Warning</p>
                      {nextAction.warnings.map((w, i) => (
                        <p key={i} className="text-yellow-700 dark:text-yellow-300">{w}</p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Draft preview */}
              {nextAction.draft_content && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Draft Preview</span>
                    <Button variant="ghost" size="sm" className="h-6 text-xs">
                      <Eye className="h-3 w-3 mr-1" />
                      View Full
                    </Button>
                  </div>
                  <div className="bg-muted rounded p-2 text-xs max-h-24 overflow-auto">
                    {nextAction.draft_preview || nextAction.draft_content.substring(0, 200)}...
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 flex-wrap">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      onClick={handleApprove}
                      disabled={isLoading}
                      className="flex-1"
                    >
                      {isLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <CheckCircle className="h-3 w-3 mr-1" />
                      )}
                      {getApproveButtonText()}
                    </Button>
                  </TooltipTrigger>
                  {nextAction.draft_preview && (
                    <TooltipContent className="max-w-sm">
                      <p className="text-xs whitespace-pre-wrap">{nextAction.draft_preview}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAdjustModalOpen(true)}
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

              {/* Why blocked */}
              {nextAction.blocked_reason && (
                <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted rounded p-2">
                  <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>Requires approval: {nextAction.blocked_reason}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Separator />

        {/* Request Details with Scope Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Request Scope</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {request.scope_items && request.scope_items.length > 0 ? (
              <ScopeBreakdown items={request.scope_items} />
            ) : (
              <div>
                <span className="text-muted-foreground">Scope:</span>
                <p className="font-medium">{request.scope_summary || "—"}</p>
              </div>
            )}

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

        {/* Agency Info with inline rules */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              Agency Profile
              <a
                href={`/agencies/detail?id=${agency.id}`}
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

            {/* Inline rules */}
            {agency.rules && (
              <div className="pt-2 space-y-1 text-xs border-t">
                {agency.rules.fee_auto_approve_threshold !== null && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Fee threshold:</span>
                    <span>{formatCurrency(agency.rules.fee_auto_approve_threshold)}</span>
                  </div>
                )}
                {agency.rules.always_human_gates.length > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Always-human:</span>
                    <div className="flex gap-1">
                      {agency.rules.always_human_gates.map((g, i) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {g}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {agency.rules.known_exemptions.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">Known exemptions:</span>
                    <div className="mt-1 space-y-0.5">
                      {agency.rules.known_exemptions.map((e, i) => (
                        <p key={i} className="text-[10px] text-orange-600">{e}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

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

      {/* Adjust Modal */}
      <AdjustModal
        open={adjustModalOpen}
        onOpenChange={setAdjustModalOpen}
        onSubmit={handleRevise}
        constraints={request.constraints}
        isLoading={isLoading}
      />
    </ScrollArea>
  );
}
