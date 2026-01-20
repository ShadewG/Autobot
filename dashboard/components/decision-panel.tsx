"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { PauseReason, FeeQuote, AgencyRules } from "@/lib/types";
import { formatCurrency, PAUSE_REASON_LABELS } from "@/lib/utils";
import {
  AlertTriangle,
  DollarSign,
  Scale,
  Ban,
  UserCheck,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Info,
} from "lucide-react";

interface DecisionPanelProps {
  pauseReason: PauseReason;
  feeQuote?: FeeQuote;
  agencyRules?: AgencyRules;
  onDecision: (decision: string, params?: Record<string, unknown>) => void;
  isLoading?: boolean;
}

// Single recommended action per gate type
const RECOMMENDATIONS: Record<PauseReason, { id: string; label: string }> = {
  FEE_QUOTE: { id: "approve_deposit", label: "Proceed with deposit" },
  SCOPE: { id: "accept", label: "Accept narrowed scope" },
  DENIAL: { id: "appeal", label: "File appeal" },
  ID_REQUIRED: { id: "provide_id", label: "Provide ID" },
  SENSITIVE: { id: "modify", label: "Modify request" },
  CLOSE_ACTION: { id: "complete", label: "Mark complete" },
};

// Alternative options (shown when expanded)
const ALTERNATIVES: Record<PauseReason, { id: string; label: string }[]> = {
  FEE_QUOTE: [
    { id: "request_itemization", label: "Request itemized estimate" },
    { id: "narrow_scope", label: "Narrow scope to reduce cost" },
  ],
  SCOPE: [
    { id: "counter", label: "Counter-propose" },
    { id: "clarify", label: "Request clarification" },
  ],
  DENIAL: [
    { id: "revise", label: "Revise & resubmit" },
    { id: "escalate", label: "Escalate" },
  ],
  ID_REQUIRED: [
    { id: "request_waiver", label: "Request waiver" },
  ],
  SENSITIVE: [
    { id: "proceed", label: "Proceed with caution" },
    { id: "escalate", label: "Escalate for review" },
  ],
  CLOSE_ACTION: [
    { id: "continue", label: "Continue pursuing" },
  ],
};

const GATE_ICONS: Record<PauseReason, React.ComponentType<{ className?: string }>> = {
  FEE_QUOTE: DollarSign,
  SCOPE: Scale,
  DENIAL: Ban,
  ID_REQUIRED: UserCheck,
  SENSITIVE: AlertTriangle,
  CLOSE_ACTION: CheckCircle,
};

export function DecisionPanel({
  pauseReason,
  feeQuote,
  agencyRules,
  onDecision,
  isLoading,
}: DecisionPanelProps) {
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showCostCap, setShowCostCap] = useState(false);
  const [costCap, setCostCap] = useState<string>("");

  const Icon = GATE_ICONS[pauseReason];
  const recommendation = RECOMMENDATIONS[pauseReason];
  const alternatives = ALTERNATIVES[pauseReason];

  const showFeeDetails = pauseReason === "FEE_QUOTE" && feeQuote;

  return (
    <Card className="border-yellow-200 bg-yellow-50/50 dark:bg-yellow-950/20 dark:border-yellow-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-yellow-600" />
          {PAUSE_REASON_LABELS[pauseReason]}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Fee details - compact */}
        {showFeeDetails && (
          <div className="bg-white dark:bg-gray-900 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Fee</span>
              <span className="font-bold text-lg">{formatCurrency(feeQuote.amount)}</span>
            </div>
            {feeQuote.deposit_amount && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Deposit</span>
                <span>{formatCurrency(feeQuote.deposit_amount)}</span>
              </div>
            )}
          </div>
        )}

        {/* Single recommendation line */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">Recommended</Badge>
            <span className="text-sm font-medium">{recommendation.label}</span>
          </div>
          <button
            onClick={() => setShowAlternatives(!showAlternatives)}
            className="text-xs text-primary hover:underline"
          >
            {showAlternatives ? "Hide options" : "Change..."}
          </button>
        </div>

        {/* Alternatives (collapsed by default) */}
        {showAlternatives && (
          <div className="space-y-1 pl-2 border-l-2 border-muted">
            {alternatives.map((alt) => (
              <button
                key={alt.id}
                onClick={() => onDecision(alt.id)}
                disabled={isLoading}
                className="block text-sm text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
              >
                {alt.label}
              </button>
            ))}
          </div>
        )}

        {/* Cost cap - collapsed */}
        {pauseReason === "FEE_QUOTE" && (
          <Collapsible open={showCostCap} onOpenChange={setShowCostCap}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {showCostCap ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Optional: set max cost...
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <div className="flex gap-2">
                <Input
                  type="number"
                  placeholder="$"
                  value={costCap}
                  onChange={(e) => setCostCap(e.target.value)}
                  className="w-20 h-7 text-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onDecision("set_cap", { cap: parseFloat(costCap) })}
                  disabled={!costCap || isLoading}
                >
                  Apply
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Why paused - subtle */}
        {agencyRules && agencyRules.fee_auto_approve_threshold !== null && pauseReason === "FEE_QUOTE" && (
          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Info className="h-2.5 w-2.5" />
            Fee exceeds ${agencyRules.fee_auto_approve_threshold} auto-approve threshold
          </p>
        )}
      </CardContent>
    </Card>
  );
}
