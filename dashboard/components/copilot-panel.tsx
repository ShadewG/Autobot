"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConstraintsDisplay } from "./constraints-display";
import { ScopeTable, ScopeSummary } from "./scope-table";
import { FeeBreakdown } from "./fee-breakdown";
import { ExemptionClaimsList } from "./exemption-claim-card";
import { requestsAPI } from "@/lib/api";
import type {
  NextAction,
  RequestDetail,
  AgencySummary,
  ScopeItem,
} from "@/lib/types";
import { formatCurrency, formatDate, formatReasoning } from "@/lib/utils";
import {
  AlertTriangle,
  DollarSign,
  ExternalLink,
  Info,
} from "lucide-react";

interface CopilotPanelProps {
  request: RequestDetail;
  nextAction: NextAction | null;
  agency: AgencySummary;
  onChallenge?: (instruction: string) => void;
  onRefresh?: () => void;
}

export function CopilotPanel({
  request,
  nextAction,
  agency,
  onChallenge,
  onRefresh,
}: CopilotPanelProps) {
  const [isUpdatingScope, setIsUpdatingScope] = useState(false);
  const hasAgencyDetailLink = Boolean(agency?.id && /^\d+$/.test(String(agency.id)));

  const handleScopeStatusChange = async (
    itemIndex: number,
    newStatus: ScopeItem['status'],
    reason?: string
  ) => {
    setIsUpdatingScope(true);
    try {
      await requestsAPI.updateScopeItem(request.id, itemIndex, newStatus, reason);
      onRefresh?.();
    } catch (error) {
      console.error('Error updating scope item:', error);
      alert('Failed to update scope item status');
    } finally {
      setIsUpdatingScope(false);
    }
  };
  // Hide "Proposed Action" when decision is required (shown in DecisionPanel instead)
  const isDecisionRequired =
    Boolean(request.pause_reason) ||
    request.requires_human ||
    request.status?.toUpperCase() === "PAUSED" ||
    request.status?.toUpperCase() === "NEEDS_HUMAN_REVIEW" ||
    request.status?.toLowerCase().includes("needs_human");

  const showProposal = !isDecisionRequired && nextAction;

  return (
    <ScrollArea className="h-[calc(100vh-300px)]">
      <div className="space-y-4 pr-4">

        {/* Constraints detected */}
        {request.constraints && request.constraints.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Agency Requirements</CardTitle>
            </CardHeader>
            <CardContent>
              <ConstraintsDisplay constraints={request.constraints} />
            </CardContent>
          </Card>
        )}

        {/* Next Action Proposal - only show when autopilot is running (no decision required) */}
        {showProposal && (
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
                {formatReasoning(nextAction.reasoning, 5).map((reason, i) => (
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

              {/* Review notes from safety check */}
              {nextAction.warnings && nextAction.warnings.length > 0 && (
                <div className="bg-muted/50 border border-border rounded-lg p-2">
                  <div className="flex items-start gap-2">
                    <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                    <div className="text-xs">
                      <p className="font-medium text-muted-foreground">Review Notes</p>
                      {nextAction.warnings.map((w, i) => (
                        <p key={i} className="text-muted-foreground">{w}</p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Draft preview - not shown here when decision required (shown in DecisionPanel) */}
              {nextAction.draft_content && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Draft Preview</span>
                  <div className="bg-muted rounded p-2 text-xs max-h-32 overflow-auto whitespace-pre-wrap">
                    {nextAction.draft_preview || nextAction.draft_content.substring(0, 300)}...
                  </div>
                </div>
              )}

              {/* Why blocked - subtle note */}
              {nextAction.blocked_reason && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Info className="h-2.5 w-2.5" />
                  {nextAction.blocked_reason}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <Separator />

        {/* Exemption Claims - prominent when present */}
        {request.constraints && request.constraints.length > 0 && (
          <ExemptionClaimsList
            constraints={request.constraints}
            state={request.state}
            requestId={request.id}
            onChallenge={onChallenge}
          />
        )}

        {/* Fee Breakdown - shown when there's a fee quote */}
        {request.fee_quote && request.fee_quote.amount > 0 && (
          <FeeBreakdown
            feeQuote={request.fee_quote}
            scopeItems={request.scope_items}
          />
        )}

        {/* Request Scope with Table */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Request Scope</span>
              {request.scope_items && request.scope_items.length > 0 && (
                <ScopeSummary items={request.scope_items} />
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {request.scope_items && request.scope_items.length > 0 ? (
              <ScopeTable
                items={request.scope_items}
                onStatusChange={handleScopeStatusChange}
                isUpdating={isUpdatingScope}
              />
            ) : (
              <div>
                <span className="text-muted-foreground">Scope:</span>
                <p className="font-medium">{request.scope_summary || "—"}</p>
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

        {/* Agency Info - simplified, key info only */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              Agency
              {hasAgencyDetailLink ? (
                <a
                  href={`/agencies/detail?id=${agency.id}`}
                  className="text-xs text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3 inline mr-1" />
                  Full profile
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">Profile unavailable</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {/* Key info: name + submission method */}
            <div className="flex items-center justify-between">
              <span className="font-medium">{agency.name}</span>
              <Badge variant="outline">{agency.submission_method}</Badge>
            </div>

            {/* Key rules: only fee threshold + always-human gates */}
            {agency.rules && (
              <div className="text-xs space-y-1">
                {agency.rules.fee_auto_approve_threshold !== null && (
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Auto-approve fees under</span>
                    <span className="font-medium text-foreground">
                      {formatCurrency(agency.rules.fee_auto_approve_threshold)}
                    </span>
                  </div>
                )}
                {agency.rules.always_human_gates.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-muted-foreground">Always-human:</span>
                    {agency.rules.always_human_gates.map((g, i) => (
                      <Badge key={i} variant="secondary" className="text-[10px]">
                        {g}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
