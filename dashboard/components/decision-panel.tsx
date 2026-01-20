"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RequestDetail, NextAction, AgencySummary, PauseReason, ThreadMessage } from "@/lib/types";
import {
  CheckCircle,
  MessageSquare,
  XCircle,
  DollarSign,
  FileQuestion,
  Scale,
  Globe,
  MoreHorizontal,
  ArrowRight,
  AlertTriangle,
  Loader2,
  Pencil,
  UserCheck,
  Ban,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DecisionPanelProps {
  request: RequestDetail;
  nextAction: NextAction | null;
  agency: AgencySummary;
  lastInboundMessage?: ThreadMessage | null;
  onProceed: (costCap?: number) => Promise<void>;
  onNegotiate: () => void;
  onWithdraw: () => void;
  onNarrowScope: () => void;
  onAppeal: () => void;
  onOpenPortal?: () => void;
  isLoading?: boolean;
}

// Extract key points from inbound message
function extractAgencyPoints(request: RequestDetail, lastMsg?: ThreadMessage | null): string[] {
  const points: string[] = [];

  // Fee info
  if (request.cost_amount) {
    const feeStr = `Fee estimate: $${request.cost_amount.toLocaleString()}`;
    points.push(feeStr);
  }
  if (request.fee_quote?.deposit_amount) {
    points.push(`Deposit required: $${request.fee_quote.deposit_amount.toLocaleString()}`);
  }

  // Parse last message for common phrases
  if (lastMsg?.body) {
    const body = lastMsg.body.toLowerCase();

    // BWC/video not available
    if (body.includes("not subject to") && (body.includes("bwc") || body.includes("body") || body.includes("camera"))) {
      points.push("BWC not subject to disclosure");
    } else if (body.includes("not subject to disclosure") || body.includes("not disclosable")) {
      points.push("Some records not disclosable");
    }

    // No video/footage
    if (body.includes("no video") || body.includes("no footage") || body.includes("no interrogation")) {
      points.push("No video/footage available");
    }

    // Exemption cited
    if (body.includes("exempt") && !body.includes("non-exempt")) {
      points.push("Exemption cited");
    }

    // Not held
    if (body.includes("not held") || body.includes("do not have") || body.includes("don't have")) {
      points.push("Some records not held");
    }
  }

  return points;
}

// Gate-specific configuration
interface GateConfig {
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  title: string;
  getQuestion: (request: RequestDetail) => string;
  primaryAction: {
    label: string;
    subtext?: (request: RequestDetail, costCap?: string) => string | null;
    recommended?: boolean;
  };
  secondaryAction?: {
    label: string;
    recommended?: boolean;
  };
  overflowActions: string[];
  getRecommendation?: (request: RequestDetail, nextAction: NextAction | null, agencyPoints: string[]) => string | null;
}

const GATE_CONFIGS: Record<PauseReason, GateConfig> = {
  FEE_QUOTE: {
    icon: <DollarSign className="h-5 w-5" />,
    color: "text-amber-700",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-300",
    title: "Fee Quote",
    getQuestion: (r) => {
      const deposit = r.fee_quote?.deposit_amount;
      const total = r.cost_amount;
      if (deposit && total) {
        return `Do we proceed with $${deposit.toLocaleString()} deposit toward ~$${total.toLocaleString()} total?`;
      }
      if (total) {
        return `Approve $${total.toLocaleString()} fee to proceed?`;
      }
      return "Approve the quoted fee to proceed?";
    },
    primaryAction: {
      label: "Proceed",
      subtext: (r, cap) => {
        const parts: string[] = [];
        if (r.fee_quote?.deposit_amount) {
          parts.push(`Pay $${r.fee_quote.deposit_amount} deposit`);
        }
        if (cap) {
          parts.push(`cap at $${cap}`);
        }
        return parts.length > 0 ? parts.join("; ") : null;
      },
    },
    secondaryAction: {
      label: "Negotiate",
      recommended: false, // Will be set dynamically
    },
    overflowActions: ["Request itemized breakdown", "Set cost cap", "Withdraw"],
    getRecommendation: (r, _, points) => {
      const hasUnavailable = points.some(p =>
        p.includes("not subject") || p.includes("not disclosable") || p.includes("not available") || p.includes("not held")
      );
      const highFee = r.cost_amount && r.cost_amount > 100;

      if (hasUnavailable && highFee) {
        return "Consider negotiating: Fee is significant and some records unavailable. Request itemization or narrow scope to exclude unavailable items.";
      }
      if (hasUnavailable) {
        return "Some records unavailable. Consider narrowing scope before proceeding.";
      }
      if (highFee) {
        return "Fee above average. Consider requesting itemization.";
      }
      return null;
    },
  },
  DENIAL: {
    icon: <Ban className="h-5 w-5" />,
    color: "text-red-700",
    bgColor: "bg-red-50",
    borderColor: "border-red-300",
    title: "Denial",
    getQuestion: () => "How should we respond to the denial?",
    primaryAction: {
      label: "Send Appeal",
    },
    secondaryAction: {
      label: "Narrow & Retry",
    },
    overflowActions: ["Acknowledge & close", "Withdraw"],
    getRecommendation: () => "Review denial reason. If exemption cited, consider narrowing scope to non-exempt records.",
  },
  SCOPE: {
    icon: <FileQuestion className="h-5 w-5" />,
    color: "text-orange-700",
    bgColor: "bg-orange-50",
    borderColor: "border-orange-300",
    title: "Scope Issue",
    getQuestion: () => "Agency needs scope clarification. How should we respond?",
    primaryAction: {
      label: "Narrow Scope",
    },
    secondaryAction: {
      label: "Clarify Request",
    },
    overflowActions: ["Withdraw"],
  },
  ID_REQUIRED: {
    icon: <UserCheck className="h-5 w-5" />,
    color: "text-blue-700",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-300",
    title: "ID Required",
    getQuestion: () => "Agency requires identity verification to proceed.",
    primaryAction: {
      label: "Provide ID",
    },
    secondaryAction: {
      label: "Contest Requirement",
    },
    overflowActions: ["Withdraw"],
  },
  SENSITIVE: {
    icon: <AlertTriangle className="h-5 w-5" />,
    color: "text-purple-700",
    bgColor: "bg-purple-50",
    borderColor: "border-purple-300",
    title: "Sensitive Content",
    getQuestion: () => "Request flagged for sensitive content review.",
    primaryAction: {
      label: "Approve & Continue",
    },
    secondaryAction: {
      label: "Modify Request",
    },
    overflowActions: ["Withdraw"],
  },
  CLOSE_ACTION: {
    icon: <CheckCircle className="h-5 w-5" />,
    color: "text-green-700",
    bgColor: "bg-green-50",
    borderColor: "border-green-300",
    title: "Ready to Close",
    getQuestion: () => "Request appears complete. Confirm closure?",
    primaryAction: {
      label: "Confirm Complete",
    },
    secondaryAction: {
      label: "Request More Records",
    },
    overflowActions: [],
  },
};

export function DecisionPanel({
  request,
  nextAction,
  agency,
  lastInboundMessage,
  onProceed,
  onNegotiate,
  onWithdraw,
  onNarrowScope,
  onAppeal,
  onOpenPortal,
  isLoading,
}: DecisionPanelProps) {
  const [costCap, setCostCap] = useState<string>("");
  const [showCostCap, setShowCostCap] = useState(false);

  // If not paused, show minimal status
  if (!request.requires_human || !request.pause_reason) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-green-700">
            <CheckCircle className="h-4 w-4" />
            No Decision Required
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Autopilot is handling this request.
          </p>
        </CardContent>
      </Card>
    );
  }

  const config = GATE_CONFIGS[request.pause_reason];
  if (!config) {
    return null;
  }

  const agencyPoints = extractAgencyPoints(request, lastInboundMessage);
  const recommendation = config.getRecommendation?.(request, nextAction, agencyPoints);
  const shouldRecommendNegotiate = recommendation?.toLowerCase().includes("negotiat") ||
                                    recommendation?.toLowerCase().includes("narrow");

  const handlePrimaryClick = async () => {
    if (request.pause_reason === "DENIAL") {
      onAppeal();
    } else if (request.pause_reason === "SCOPE") {
      onNarrowScope();
    } else {
      await onProceed(costCap ? parseFloat(costCap) : undefined);
    }
  };

  const handleSecondaryClick = () => {
    if (request.pause_reason === "DENIAL") {
      onNarrowScope();
    } else {
      onNegotiate();
    }
  };

  return (
    <Card className={cn("border-2", config.borderColor, config.bgColor)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className={cn("text-base flex items-center gap-2", config.color)}>
            {config.icon}
            Decision Required
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Gate type + amount badge */}
        <Badge
          variant="outline"
          className={cn("font-semibold text-sm px-3 py-1", config.color, config.borderColor)}
        >
          {config.title}
          {request.pause_reason === "FEE_QUOTE" && request.cost_amount && (
            <> — ${request.cost_amount.toLocaleString()}
              {request.fee_quote?.deposit_amount && (
                <span className="font-normal opacity-80">
                  {" "}(${request.fee_quote.deposit_amount} deposit)
                </span>
              )}
            </>
          )}
        </Badge>

        {/* The explicit decision question */}
        <p className="text-sm font-semibold">
          {config.getQuestion(request)}
        </p>

        {/* Agency says section */}
        {agencyPoints.length > 0 && (
          <div className="bg-white/60 rounded-md p-3 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Agency says:
            </p>
            <ul className="text-sm space-y-1">
              {agencyPoints.map((point, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-muted-foreground mt-0.5">•</span>
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recommendation */}
        {recommendation && (
          <div className="bg-white/80 rounded-md p-3 border border-amber-200">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-amber-700 mb-1">Recommendation</p>
                <p className="text-sm">{recommendation}</p>
              </div>
            </div>
          </div>
        )}

        <Separator className="bg-white/50" />

        {/* Cost cap for fee quotes */}
        {request.pause_reason === "FEE_QUOTE" && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Cost cap:</span>
            {showCostCap || costCap ? (
              <div className="flex items-center gap-1">
                <span>$</span>
                <Input
                  type="number"
                  value={costCap}
                  onChange={(e) => setCostCap(e.target.value)}
                  className="w-24 h-7 bg-white"
                  placeholder="Max total"
                  autoFocus={showCostCap && !costCap}
                />
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => setShowCostCap(true)}
              >
                Set maximum...
              </Button>
            )}
          </div>
        )}

        {/* Action buttons - stacked for prominence */}
        <div className="space-y-2 pt-2">
          {/* Show Negotiate first if recommended */}
          {shouldRecommendNegotiate && config.secondaryAction && (
            <>
              <Button
                onClick={handleSecondaryClick}
                variant="default"
                className="w-full justify-between"
                disabled={isLoading}
              >
                <span className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  {config.secondaryAction.label}
                  <Badge variant="secondary" className="ml-1 text-[10px]">Recommended</Badge>
                </span>
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                onClick={handlePrimaryClick}
                variant="outline"
                className="w-full justify-between bg-white"
                disabled={isLoading}
              >
                <span className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4" />
                  {config.primaryAction.label}
                  {config.primaryAction.subtext?.(request, costCap) && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({config.primaryAction.subtext(request, costCap)})
                    </span>
                  )}
                </span>
                <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          )}

          {/* Normal order: Primary first */}
          {!shouldRecommendNegotiate && (
            <>
              <Button
                onClick={handlePrimaryClick}
                variant="default"
                className="w-full justify-between"
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" />
                    {config.primaryAction.label}
                    {config.primaryAction.subtext?.(request, costCap) && (
                      <span className="text-xs opacity-80">
                        ({config.primaryAction.subtext(request, costCap)})
                      </span>
                    )}
                  </span>
                )}
                <ArrowRight className="h-4 w-4" />
              </Button>

              {config.secondaryAction && (
                <Button
                  onClick={handleSecondaryClick}
                  variant="outline"
                  className="w-full justify-between bg-white"
                  disabled={isLoading}
                >
                  <span className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    {config.secondaryAction.label}
                  </span>
                  <ArrowRight className="h-4 w-4" />
                </Button>
              )}
            </>
          )}

          {/* Overflow menu */}
          {config.overflowActions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full">
                  <MoreHorizontal className="h-4 w-4 mr-2" />
                  More options
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-52">
                {config.overflowActions.map((action) => (
                  <DropdownMenuItem
                    key={action}
                    onClick={() => {
                      if (action === "Withdraw" || action === "Acknowledge & close") {
                        onWithdraw();
                      } else if (action === "Set cost cap") {
                        setShowCostCap(true);
                      } else if (action === "Request itemized breakdown") {
                        onNegotiate();
                      }
                    }}
                  >
                    {action}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Link to draft if available */}
        {nextAction?.draft_content && (
          <button
            onClick={() => {
              document.querySelector("[data-draft-preview]")?.scrollIntoView({ behavior: "smooth" });
            }}
            className="text-xs text-primary hover:underline block"
          >
            View prepared response draft →
          </button>
        )}
      </CardContent>
    </Card>
  );
}
