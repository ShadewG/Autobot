"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConstraintsDisplay } from "./constraints-display";
import { ScopeBreakdown } from "./scope-breakdown";
import type {
  NextAction,
  RequestDetail,
  AgencySummary,
} from "@/lib/types";
import { formatCurrency, formatDate } from "@/lib/utils";
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
}

export function CopilotPanel({
  request,
  nextAction,
  agency,
}: CopilotPanelProps) {
  return (
    <ScrollArea className="h-[calc(100vh-300px)]">
      <div className="space-y-4 pr-4">

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

        {/* Agency Info - simplified, key info only */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              Agency
              <a
                href={`/agencies/detail?id=${agency.id}`}
                className="text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3 inline mr-1" />
                Full profile
              </a>
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
