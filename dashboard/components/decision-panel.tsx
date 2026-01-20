"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PauseReason, FeeQuote, AgencyRules } from "@/lib/types";
import { formatCurrency, PAUSE_REASON_LABELS } from "@/lib/utils";
import {
  AlertTriangle,
  DollarSign,
  FileText,
  Scale,
  Ban,
  UserCheck,
  CheckCircle,
  XCircle,
  ArrowRight,
  Info,
} from "lucide-react";

interface DecisionPanelProps {
  pauseReason: PauseReason;
  feeQuote?: FeeQuote;
  agencyRules?: AgencyRules;
  onDecision: (decision: string, params?: Record<string, unknown>) => void;
  isLoading?: boolean;
}

const DECISION_CONFIG: Record<PauseReason, {
  icon: React.ComponentType<{ className?: string }>;
  options: { id: string; label: string; recommended?: boolean; variant?: "default" | "outline" | "destructive" }[];
}> = {
  FEE_QUOTE: {
    icon: DollarSign,
    options: [
      { id: "request_itemization", label: "Request itemized estimate", recommended: true },
      { id: "approve_deposit", label: "Proceed with deposit" },
      { id: "narrow_scope", label: "Narrow scope", variant: "outline" },
      { id: "withdraw", label: "Withdraw", variant: "destructive" },
    ],
  },
  SCOPE: {
    icon: Scale,
    options: [
      { id: "accept", label: "Accept narrowed scope", recommended: true },
      { id: "counter", label: "Counter-propose" },
      { id: "clarify", label: "Request clarification", variant: "outline" },
      { id: "withdraw", label: "Withdraw", variant: "destructive" },
    ],
  },
  DENIAL: {
    icon: Ban,
    options: [
      { id: "appeal", label: "File appeal", recommended: true },
      { id: "revise", label: "Revise & resubmit" },
      { id: "escalate", label: "Escalate", variant: "outline" },
      { id: "accept", label: "Accept denial", variant: "destructive" },
    ],
  },
  ID_REQUIRED: {
    icon: UserCheck,
    options: [
      { id: "provide_id", label: "Provide ID", recommended: true },
      { id: "request_waiver", label: "Request waiver" },
      { id: "withdraw", label: "Withdraw", variant: "destructive" },
    ],
  },
  SENSITIVE: {
    icon: AlertTriangle,
    options: [
      { id: "proceed", label: "Proceed with caution" },
      { id: "modify", label: "Modify request", recommended: true },
      { id: "escalate", label: "Escalate for review", variant: "outline" },
    ],
  },
  CLOSE_ACTION: {
    icon: CheckCircle,
    options: [
      { id: "complete", label: "Mark complete", recommended: true },
      { id: "continue", label: "Continue pursuing" },
    ],
  },
};

export function DecisionPanel({
  pauseReason,
  feeQuote,
  agencyRules,
  onDecision,
  isLoading,
}: DecisionPanelProps) {
  const [costCap, setCostCap] = useState<string>("");

  const config = DECISION_CONFIG[pauseReason];
  const Icon = config.icon;

  const showFeeDetails = pauseReason === "FEE_QUOTE" && feeQuote;
  const showCostCapInput = pauseReason === "FEE_QUOTE";

  return (
    <Card className="border-yellow-200 bg-yellow-50/50 dark:bg-yellow-950/20 dark:border-yellow-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-yellow-600" />
          Decision Required: {PAUSE_REASON_LABELS[pauseReason]}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Fee details */}
        {showFeeDetails && (
          <div className="bg-white dark:bg-gray-900 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total quoted</span>
              <span className="font-bold text-lg">{formatCurrency(feeQuote.total_amount)}</span>
            </div>
            {feeQuote.deposit_amount && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Deposit required</span>
                <span className="font-medium">{formatCurrency(feeQuote.deposit_amount)}</span>
              </div>
            )}
            {feeQuote.itemization && feeQuote.itemization.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-xs text-muted-foreground mb-1">Itemization:</p>
                {feeQuote.itemization.map((item, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span>{item.item}</span>
                    <span>{formatCurrency(item.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Why paused explanation */}
        {agencyRules && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-white dark:bg-gray-900 rounded p-2">
            <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">Why this requires approval:</p>
              {pauseReason === "FEE_QUOTE" && agencyRules.fee_auto_approve_threshold !== null && (
                <p>Fee ({formatCurrency(feeQuote?.total_amount || 0)}) exceeds auto-approve threshold ({formatCurrency(agencyRules.fee_auto_approve_threshold)})</p>
              )}
              {agencyRules.always_human_gates.includes(pauseReason) && (
                <p>This gate type always requires human review for this agency</p>
              )}
            </div>
          </div>
        )}

        {/* Cost cap input for fee quotes */}
        {showCostCapInput && (
          <div className="space-y-2">
            <Label htmlFor="cost-cap" className="text-xs">Set cost cap (optional)</Label>
            <div className="flex gap-2">
              <Input
                id="cost-cap"
                type="number"
                placeholder="Max $"
                value={costCap}
                onChange={(e) => setCostCap(e.target.value)}
                className="w-24 h-8 text-sm"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDecision("set_cap", { cap: parseFloat(costCap) })}
                disabled={!costCap || isLoading}
              >
                Apply cap
              </Button>
            </div>
          </div>
        )}

        {/* Decision buttons */}
        <div className="space-y-2">
          {config.options.map((option) => (
            <Button
              key={option.id}
              variant={option.variant || "default"}
              size="sm"
              className="w-full justify-start"
              onClick={() => onDecision(option.id)}
              disabled={isLoading}
            >
              {option.recommended && (
                <Badge variant="secondary" className="mr-2 text-[10px] px-1">
                  Recommended
                </Badge>
              )}
              {option.label}
              <ArrowRight className="h-3 w-3 ml-auto" />
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
