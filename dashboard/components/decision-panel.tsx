"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RequestDetail, NextAction, AgencySummary, PauseReason, ReviewReason, ThreadMessage, ReviewState } from "@/lib/types";
import {
  CheckCircle,
  MessageSquare,
  DollarSign,
  FileQuestion,
  MoreHorizontal,
  ArrowRight,
  AlertTriangle,
  Loader2,
  UserCheck,
  Ban,
  Info,
  ChevronDown,
  ChevronUp,
  FileText,
  HelpCircle,
  Globe,
  Mail,
  RotateCcw,
  Pause,
  XCircle,
  Search,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DecisionPanelProps {
  request: RequestDetail;
  nextAction: NextAction | null;
  agency: AgencySummary;
  lastInboundMessage?: ThreadMessage | null;
  reviewState?: ReviewState | null;
  onProceed: (costCap?: number) => Promise<void>;
  onNegotiate: () => void;
  onCustomAdjust?: () => void;
  onWithdraw: () => void;
  onNarrowScope: () => void;
  onAppeal: () => void;
  onOpenPortal?: () => void;
  onAddToPhoneQueue?: () => void;
  onResolveReview?: (action: string, instruction?: string) => Promise<void>;
  isLoading?: boolean;
}

// Normalized pause reason type (includes UNKNOWN)
type NormalizedPauseReason = PauseReason | "UNKNOWN";

// Normalize pause reason strings to expected enum values
// Also tries to infer from request fields and message content when pause_reason is null
function normalizePauseReason(
  raw: string | null | undefined,
  request?: RequestDetail,
  lastMsg?: ThreadMessage | null
): NormalizedPauseReason {
  // First try the raw pause_reason value
  if (raw) {
    const v = raw.toUpperCase();

    if (v.includes("FEE") || v.includes("QUOTE") || v.includes("COST") || v.includes("PAYMENT")) return "FEE_QUOTE";
    if (v.includes("DENIAL") || v.includes("DENIED") || v.includes("REJECT")) return "DENIAL";
    if (v.includes("SCOPE") || v.includes("CLARIF") || v.includes("BROAD")) return "SCOPE";
    if (v.includes("ID") || v.includes("IDENTITY") || v.includes("VERIF")) return "ID_REQUIRED";
    if (v.includes("SENSITIVE")) return "SENSITIVE";
    if (v.includes("CLOSE") || v.includes("COMPLETE") || v.includes("DONE")) return "CLOSE_ACTION";
    if (v.includes("UNSPECIFIED") || v.includes("UNKNOWN")) {
      const sub = (request?.substatus || "").toLowerCase();
      if (sub.includes("fee") || sub.includes("cost") || sub.includes("deposit")) return "FEE_QUOTE";
      if (sub.includes("denial") || sub.includes("denied") || sub.includes("reject")) return "DENIAL";
      if (sub.includes("scope") || sub.includes("clarif") || sub.includes("narrow")) return "SCOPE";
    }

    // Don't return SENSITIVE just for "REVIEW" - that's too generic
    if (!v.includes("REVIEW")) {
      // If we got here with a non-empty string that didn't match, fall through to inference
    }
  }

  // Try to infer from request fields
  if (request) {
    // If there's a cost amount or fee quote, it's likely a fee quote
    if (request.cost_amount && request.cost_amount > 0) return "FEE_QUOTE";
    if (request.fee_quote?.deposit_amount) return "FEE_QUOTE";
    if (request.cost_status && request.cost_status !== "NONE") return "FEE_QUOTE";
  }

  // Try to infer from last inbound message content
  if (lastMsg?.body) {
    const body = lastMsg.body.toLowerCase();

    // Fee indicators
    if (
      body.includes("fee") ||
      body.includes("cost") ||
      body.includes("deposit") ||
      body.includes("payment") ||
      body.includes("$") ||
      body.includes("estimate") ||
      body.includes("invoice")
    ) {
      return "FEE_QUOTE";
    }

    // Denial indicators
    if (
      body.includes("denied") ||
      body.includes("denial") ||
      body.includes("rejected") ||
      body.includes("cannot fulfill") ||
      body.includes("unable to provide")
    ) {
      return "DENIAL";
    }

    // Scope indicators
    if (
      body.includes("too broad") ||
      body.includes("overly broad") ||
      body.includes("clarify") ||
      body.includes("clarification") ||
      body.includes("narrow") ||
      body.includes("specify")
    ) {
      return "SCOPE";
    }

    // ID indicators
    if (
      body.includes("identification") ||
      body.includes("verify your identity") ||
      body.includes("proof of")
    ) {
      return "ID_REQUIRED";
    }
  }

  return "UNKNOWN";
}

// Extract agency points - gate-aware and deduped
function extractAgencyPoints(
  request: RequestDetail,
  lastMsg?: ThreadMessage | null,
  normalizedReason?: NormalizedPauseReason
): string[] {
  const out = new Set<string>();

  // Always show known structured fields first
  if (request.cost_amount) {
    out.add(`Fee estimate: $${request.cost_amount.toLocaleString()}`);
  }
  if (request.fee_quote?.deposit_amount) {
    out.add(`Deposit required: $${request.fee_quote.deposit_amount.toLocaleString()}`);
  }

  const text = lastMsg?.body ?? "";
  const body = text.toLowerCase();

  if (!text) return Array.from(out).slice(0, 5);

  // Money mentioned in message (e.g. $75 deposit, $300 estimate)
  const amounts = [...text.matchAll(/\$([0-9][0-9,]*)/g)]
    .map(m => Number(m[1].replace(/,/g, "")))
    .filter(n => Number.isFinite(n) && n > 0);

  // Heuristic: if agency mentions two amounts, call out "deposit" + "estimate"
  if (amounts.length >= 2 && !request.cost_amount) {
    const sorted = [...amounts].sort((a, b) => a - b);
    out.add(`Agency mentions: $${sorted[0].toLocaleString()} deposit / $${sorted[sorted.length - 1].toLocaleString()} estimate`);
  }

  // Timeline (12-15 weeks, 10 business days, etc.)
  const timeMatch = text.match(/(\d+\s*-\s*\d+|\d+)\s*(weeks?|days?|business days?)/i);
  if (timeMatch) out.add(`Timeline: ${timeMatch[0]}`);

  // Payment method cues
  if (body.includes("invoice")) out.add("Payment: invoice required");
  if (body.includes("mail") && (body.includes("check") || body.includes("payment"))) out.add("Payment: mail-in payment");
  if (body.includes("portal") && body.includes("pay")) out.add("Submission/payment via portal");

  // Availability cues
  if (body.includes("not subject to") && (body.includes("body") || body.includes("bwc") || body.includes("camera"))) {
    out.add("BWC withheld (not subject to FOIA)");
  }
  if (body.includes("do not have") || body.includes("don't have") || body.includes("not held")) {
    out.add("Some items not held");
  }
  if (body.includes("no interrogation")) out.add("No interrogation video");
  if (body.includes("no video") || body.includes("no footage")) out.add("No video/footage available");

  // IMPORTANT: don't add generic "Exemption cited" for fee quotes.
  // Only add exemption if it's a DENIAL pause reason.
  if (normalizedReason === "DENIAL" && body.includes("exempt") && !body.includes("non-exempt")) {
    out.add("Exemption cited");
  }

  // Denial-specific
  if (normalizedReason === "DENIAL") {
    if (body.includes("investigative")) out.add("Investigative records exemption");
    if (body.includes("privacy")) out.add("Privacy exemption cited");
    if (body.includes("law enforcement")) out.add("Law enforcement exemption");
  }

  // Scope-specific
  if (normalizedReason === "SCOPE") {
    if (body.includes("too broad") || body.includes("overly broad")) out.add("Request deemed too broad");
    if (body.includes("clarify") || body.includes("clarification")) out.add("Clarification requested");
    if (body.includes("time frame") || body.includes("date range")) out.add("Need specific date range");
  }

  return Array.from(out).slice(0, 5);
}

// Gate-specific configuration
interface OverflowAction {
  label: string;
  description: string;
}

interface GateConfig {
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  title: string;
  getQuestion: (request: RequestDetail) => string;
  primaryAction: {
    label: string;
    description: string;
    subtext?: (request: RequestDetail, costCap?: string) => string | null;
    recommended?: boolean;
  };
  secondaryAction?: {
    label: string;
    description: string;
    recommended?: boolean;
  };
  overflowActions: OverflowAction[];
  getRecommendation?: (request: RequestDetail, nextAction: NextAction | null, agencyPoints: string[]) => string | null;
  isSupported?: boolean; // Whether actions are wired up
}

// UNKNOWN gate fallback - always show something
const UNKNOWN_GATE_CONFIG: GateConfig = {
  icon: <AlertTriangle className="h-5 w-5" />,
  color: "text-yellow-300",
  bgColor: "bg-yellow-500/10",
  borderColor: "border-yellow-700/50",
  title: "Needs Review",
  getQuestion: () => "This request is paused and needs a review decision. What do you want to do?",
  primaryAction: { label: "Proceed", description: "Resume processing this request." },
  secondaryAction: { label: "Negotiate", description: "Draft an adjustment to the current action." },
  overflowActions: [
    { label: "Add to phone queue", description: "Add this case to the phone call queue for manual follow-up." },
    { label: "Withdraw", description: "Cancel this request permanently." },
  ],
  isSupported: true,
};

const GATE_CONFIGS: Record<PauseReason, GateConfig> = {
  FEE_QUOTE: {
    icon: <DollarSign className="h-5 w-5" />,
    color: "text-amber-300",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-700/50",
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
      description: "Sends the pre-drafted fee acceptance email. Does NOT pay automatically — just confirms willingness to proceed. Sets status to Awaiting Payment.",
      subtext: () => null,
    },
    secondaryAction: {
      label: "Negotiate",
      description: "AI proposes narrowing to key officers and tighter time window to cut cost. Acknowledges the agency's breakdown and requests public interest fee waiver. You'll review the draft before it's sent.",
      recommended: false,
    },
    overflowActions: [
      { label: "Customize negotiation...", description: "Open the adjustment panel to give specific instructions for how to handle the fee." },
      { label: "Set cost cap", description: "Set a maximum you're willing to pay. The action won't auto-execute if the fee exceeds this limit." },
      { label: "Add to phone queue", description: "Add this case to the phone call queue to negotiate by phone." },
      { label: "Withdraw", description: "Cancel this request permanently." },
    ],
    getRecommendation: (r, _, points) => {
      const hasUnavailable = points.some(p =>
        p.toLowerCase().includes("not subject") ||
        p.toLowerCase().includes("withheld") ||
        p.toLowerCase().includes("not held") ||
        p.toLowerCase().includes("no video") ||
        p.toLowerCase().includes("no footage")
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
    isSupported: true,
  },
  DENIAL: {
    icon: <Ban className="h-5 w-5" />,
    color: "text-red-300",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-700/50",
    title: "Denial",
    getQuestion: () => "How should we respond to the denial?",
    primaryAction: {
      label: "Send Appeal",
      description: "AI drafts an appeal challenging the denial, citing applicable state statutes and exemption limitations based on the agency's stated reason. You'll review before it's sent.",
    },
    secondaryAction: {
      label: "Narrow & Retry",
      description: "AI drafts a narrowed-scope resubmission targeting only the records that weren't denied. Removes the items the agency can't or won't provide.",
    },
    overflowActions: [
      { label: "Add to phone queue", description: "Add this case to the phone call queue to discuss the denial by phone." },
      { label: "Acknowledge & close", description: "Close this case, recording the denial as the final outcome." },
      { label: "Withdraw", description: "Cancel this request permanently." },
    ],
    getRecommendation: () => "Review denial reason. If exemption cited, consider narrowing scope to non-exempt records.",
    isSupported: true,
  },
  SCOPE: {
    icon: <FileQuestion className="h-5 w-5" />,
    color: "text-orange-300",
    bgColor: "bg-orange-500/10",
    borderColor: "border-orange-700/50",
    title: "Scope Issue",
    getQuestion: () => "Agency needs scope clarification. How should we respond?",
    primaryAction: {
      label: "Narrow Scope",
      description: "AI drafts a response narrowing the request to address the agency's overbreadth objection, removing or limiting the contested items.",
    },
    secondaryAction: {
      label: "Clarify Request",
      description: "AI drafts a clarifying response that directly answers the agency's specific question without changing the scope of the request.",
    },
    overflowActions: [
      { label: "Add to phone queue", description: "Add this case to the phone call queue to clarify scope by phone." },
      { label: "Withdraw", description: "Cancel this request permanently." },
    ],
    isSupported: true,
  },
  ID_REQUIRED: {
    icon: <UserCheck className="h-5 w-5" />,
    color: "text-blue-300",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-700/50",
    title: "ID Required",
    getQuestion: () => "Agency requires identity verification to proceed.",
    primaryAction: {
      label: "Provide ID",
      description: "Not yet automated. You'll need to respond to the agency manually with the required identification.",
    },
    secondaryAction: {
      label: "Contest Requirement",
      description: "Draft a response challenging the ID requirement, citing that most state FOIA laws don't permit agencies to demand requester identification.",
    },
    overflowActions: [
      { label: "Add to phone queue", description: "Add this case to the phone call queue to discuss ID requirements." },
      { label: "Withdraw", description: "Cancel this request permanently." },
    ],
    isSupported: false,
  },
  SENSITIVE: {
    icon: <AlertTriangle className="h-5 w-5" />,
    color: "text-purple-300",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-700/50",
    title: "Sensitive Content",
    getQuestion: () => "Request flagged for sensitive content review.",
    primaryAction: {
      label: "Approve & Continue",
      description: "Confirm you've reviewed the sensitive content flag and allow the AI to proceed with the next action.",
    },
    secondaryAction: {
      label: "Modify Request",
      description: "Open the adjust dialog to change the scope or wording of the request to address the sensitivity concern.",
    },
    overflowActions: [
      { label: "Add to phone queue", description: "Add this case to the phone call queue." },
      { label: "Withdraw", description: "Cancel this request permanently." },
    ],
    isSupported: false,
  },
  CLOSE_ACTION: {
    icon: <CheckCircle className="h-5 w-5" />,
    color: "text-green-300",
    bgColor: "bg-green-500/10",
    borderColor: "border-green-700/50",
    title: "Ready to Close",
    getQuestion: () => "Request appears complete. Confirm closure?",
    primaryAction: {
      label: "Confirm Complete",
      description: "Mark this request as completed and close the case. Records have been received or the matter is resolved.",
    },
    secondaryAction: {
      label: "Request More Records",
      description: "The case isn't fully resolved. Keep it open and draft a follow-up requesting the remaining records.",
    },
    overflowActions: [],
    isSupported: false,
  },
};

// Review action button config
interface ReviewActionConfig {
  id: string;
  label: string;
  description: string;
  variant: "default" | "outline" | "ghost";
  recommended?: boolean;
}

// Review panel config per reason
interface ReviewConfig {
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
  title: string;
  question: string;
  actions: ReviewActionConfig[];
}

const REVIEW_CONFIGS: Record<ReviewReason, ReviewConfig> = {
  PORTAL_FAILED: {
    icon: <Globe className="h-5 w-5" />,
    color: "text-red-300",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-700/50",
    title: "Portal Submission Failed",
    question: "The portal submission failed. How should we proceed?",
    actions: [
      { id: "retry_portal", label: "Retry Portal", description: "Attempt the portal submission again", variant: "default", recommended: true },
      { id: "send_via_email", label: "Send via Email", description: "Switch to email submission instead", variant: "outline" },
      { id: "submit_manually", label: "Submit Manually", description: "Open portal URL for manual submission", variant: "outline" },
      { id: "mark_sent", label: "Mark as Sent", description: "Confirm this was already submitted successfully", variant: "outline" },
      { id: "clear_portal", label: "Clear Portal URL", description: "Remove bad portal URL so case can use email instead", variant: "ghost" },
      { id: "put_on_hold", label: "Put on Hold", description: "Pause and come back later", variant: "ghost" },
    ],
  },
  PORTAL_STUCK: {
    icon: <Globe className="h-5 w-5" />,
    color: "text-orange-300",
    bgColor: "bg-orange-500/10",
    borderColor: "border-orange-700/50",
    title: "Portal Submission Timed Out",
    question: "The portal submission was started but never completed. What happened?",
    actions: [
      { id: "mark_sent", label: "Mark as Sent", description: "The submission actually went through — mark as sent", variant: "default", recommended: true },
      { id: "retry_portal", label: "Retry Portal", description: "Attempt the portal submission again", variant: "outline" },
      { id: "submit_manually", label: "Submit Manually", description: "Open portal URL for manual submission", variant: "outline" },
      { id: "clear_portal", label: "Clear Portal URL", description: "Remove portal URL and switch to email", variant: "ghost" },
      { id: "put_on_hold", label: "Put on Hold", description: "Pause and come back later", variant: "ghost" },
    ],
  },
  FEE_QUOTE: {
    icon: <DollarSign className="h-5 w-5" />,
    color: "text-amber-300",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-700/50",
    title: "Fee Quote Received",
    question: "A fee has been quoted. What would you like to do?",
    actions: [
      { id: "accept_fee", label: "Accept & Proceed", description: "Accept the fee and continue", variant: "default", recommended: true },
      { id: "negotiate_fee", label: "Negotiate Fee", description: "Ask for a lower fee or waiver", variant: "outline" },
      { id: "close", label: "Decline & Close", description: "Decline the fee and close request", variant: "outline" },
      { id: "put_on_hold", label: "Put on Hold", description: "Pause and come back later", variant: "ghost" },
    ],
  },
  DENIAL: {
    icon: <Ban className="h-5 w-5" />,
    color: "text-red-300",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-700/50",
    title: "Request Denied",
    question: "The request was denied. How should we respond?",
    actions: [
      { id: "appeal", label: "Appeal Denial", description: "Draft an appeal citing legal grounds", variant: "default", recommended: true },
      { id: "narrow_scope", label: "Narrow Scope & Retry", description: "Reduce scope and resubmit", variant: "outline" },
      { id: "close", label: "Close Request", description: "Accept the denial and close", variant: "outline" },
      { id: "put_on_hold", label: "Put on Hold", description: "Pause and come back later", variant: "ghost" },
    ],
  },
  MISSING_INFO: {
    icon: <Search className="h-5 w-5" />,
    color: "text-blue-300",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-700/50",
    title: "Missing Information",
    question: "Additional information is needed to proceed.",
    actions: [
      { id: "reprocess", label: "Re-process", description: "Re-analyze and determine best action", variant: "default", recommended: true },
      { id: "put_on_hold", label: "Put on Hold", description: "Pause and come back later", variant: "outline" },
      { id: "close", label: "Skip / Close", description: "Close this request", variant: "ghost" },
    ],
  },
  GENERAL: {
    icon: <AlertTriangle className="h-5 w-5" />,
    color: "text-yellow-300",
    bgColor: "bg-yellow-500/10",
    borderColor: "border-yellow-700/50",
    title: "Needs Review",
    question: "This request needs human review. What would you like to do?",
    actions: [
      { id: "reprocess", label: "Re-process", description: "Re-analyze and determine best action", variant: "default", recommended: true },
      { id: "put_on_hold", label: "Put on Hold", description: "Pause and come back later", variant: "outline" },
      { id: "close", label: "Close Request", description: "Close this request", variant: "ghost" },
    ],
  },
};

export function DecisionPanel({
  request,
  nextAction,
  agency,
  lastInboundMessage,
  reviewState,
  onProceed,
  onNegotiate,
  onCustomAdjust,
  onWithdraw,
  onNarrowScope,
  onAppeal,
  onOpenPortal,
  onAddToPhoneQueue,
  onResolveReview,
  isLoading,
}: DecisionPanelProps) {
  const [costCap, setCostCap] = useState<string>("");
  const [showCostCap, setShowCostCap] = useState(false);
  const [draftExpanded, setDraftExpanded] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");
  const [showCustomInstruction, setShowCustomInstruction] = useState(false);
  const [reviewActionLoading, setReviewActionLoading] = useState<string | null>(null);

  // Use server-derived review_state when available, fall back to legacy heuristic
  const isDecisionRequired = reviewState
    ? reviewState === 'DECISION_REQUIRED'
    : (() => {
        const pauseReasonRaw = request.pause_reason ?? null;
        return Boolean(pauseReasonRaw) ||
          request.requires_human ||
          request.status?.toUpperCase() === "PAUSED" ||
          request.status?.toUpperCase() === "NEEDS_HUMAN_REVIEW" ||
          request.status?.toLowerCase().includes("needs_human") ||
          Boolean(nextAction?.blocked_reason);
      })();

  const isDecisionApplying = reviewState === 'DECISION_APPLYING';
  const isProcessing = reviewState === 'PROCESSING';

  // If decision is being applied, show "Applying Decision" card
  if (isDecisionApplying) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-blue-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            Applying Decision
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your decision has been received and is being applied by the agent.
          </p>
        </CardContent>
      </Card>
    );
  }

  // If agent is actively working (no human needed), show processing state
  if (isProcessing) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-blue-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            Agent Working
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The agent is currently processing this request.
          </p>
        </CardContent>
      </Card>
    );
  }

  // If not paused, show minimal status
  if (!isDecisionRequired) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2 text-green-300">
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

  const pauseReasonRaw = request.pause_reason ?? null;

  // Normalize the pause reason
  const normalized = normalizePauseReason(pauseReasonRaw, request, lastInboundMessage);

  // Get config - NEVER return null, use UNKNOWN fallback
  const config = normalized === "UNKNOWN"
    ? UNKNOWN_GATE_CONFIG
    : (GATE_CONFIGS[normalized] || UNKNOWN_GATE_CONFIG);

  // If we have a review_reason, show the review-specific panel with action buttons
  if (request.review_reason && onResolveReview) {
    const reviewConfig = REVIEW_CONFIGS[request.review_reason] || REVIEW_CONFIGS.GENERAL;

    const handleReviewAction = async (actionId: string) => {
      setReviewActionLoading(actionId);
      try {
        await onResolveReview(actionId, customInstruction || undefined);
      } finally {
        setReviewActionLoading(null);
      }
    };

    return (
      <Card className={cn("border-2", reviewConfig.borderColor, reviewConfig.bgColor)}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className={cn("text-base flex items-center gap-2", reviewConfig.color)}>
              {reviewConfig.icon}
              Decision Required
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Reason badge */}
          <Badge
            variant="outline"
            className={cn("font-semibold text-sm px-3 py-1", reviewConfig.color, reviewConfig.borderColor)}
          >
            {reviewConfig.title}
          </Badge>

          {/* Substatus context */}
          {request.substatus && (
            <div className="bg-muted rounded-md p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Context
              </p>
              <p className="text-sm">{request.substatus}</p>
              {request.portal_url && (request.review_reason === "PORTAL_FAILED" || request.review_reason === "PORTAL_STUCK") && (
                <a
                  href={request.portal_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline mt-1 block truncate"
                >
                  {request.portal_url}
                </a>
              )}
            </div>
          )}

          {/* The explicit decision question */}
          <p className="text-sm font-semibold">
            {reviewConfig.question}
          </p>

          <Separator className="bg-border" />

          {/* Action buttons — stacked */}
          <div className="space-y-2">
            {reviewConfig.actions.map((action) => (
              <Button
                key={action.id}
                onClick={() => handleReviewAction(action.id)}
                variant={action.variant}
                className={cn(
                  "w-full justify-between",
                  action.variant === "ghost" && "text-muted-foreground"
                )}
                disabled={isLoading || reviewActionLoading !== null}
              >
                <span className="flex items-center gap-2 text-left">
                  {reviewActionLoading === action.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <span className="text-sm">{action.label}</span>
                  )}
                  {action.recommended && (
                    <Badge variant="secondary" className="ml-1 text-[10px]">Recommended</Badge>
                  )}
                </span>
                <ArrowRight className="h-4 w-4 flex-shrink-0" />
              </Button>
            ))}
          </div>

          {/* Custom instructions textarea — collapsible */}
          <Collapsible open={showCustomInstruction} onOpenChange={setShowCustomInstruction}>
            <CollapsibleTrigger asChild>
              <button className="w-full flex items-center justify-between text-xs text-primary hover:text-primary/80 py-2 border-t border-border">
                <span className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  Custom instructions
                </span>
                {showCustomInstruction ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-2">
                <Textarea
                  value={customInstruction}
                  onChange={(e) => setCustomInstruction(e.target.value)}
                  placeholder="Add specific instructions for the agent (e.g., 'cite public interest exception', 'limit to 2023 records only')"
                  className="bg-background text-sm min-h-[80px]"
                />
                {customInstruction && (
                  <Button
                    onClick={() => handleReviewAction("custom")}
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={isLoading || reviewActionLoading !== null}
                  >
                    {reviewActionLoading === "custom" ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : null}
                    Send Custom Instruction
                  </Button>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>
    );
  }

  const agencyPoints = extractAgencyPoints(request, lastInboundMessage, normalized);
  const recommendation = config.getRecommendation?.(request, nextAction, agencyPoints);
  const shouldRecommendNegotiate = recommendation?.toLowerCase().includes("negotiat") ||
                                    recommendation?.toLowerCase().includes("narrow");

  // Check if actions are supported
  const isUnsupported = config.isSupported === false;

  const handlePrimaryClick = async () => {
    if (isUnsupported) return; // Safety check

    if (normalized === "DENIAL") {
      onAppeal();
    } else if (normalized === "SCOPE") {
      onNarrowScope();
    } else {
      await onProceed(costCap ? parseFloat(costCap) : undefined);
    }
  };

  const handleSecondaryClick = () => {
    if (isUnsupported) return; // Safety check

    if (normalized === "DENIAL") {
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
          {normalized === "FEE_QUOTE" && request.cost_amount && (
            <> — ${request.cost_amount.toLocaleString()}
              {request.fee_quote?.deposit_amount && (
                <span className="font-normal opacity-80">
                  {" "}(${request.fee_quote.deposit_amount} deposit)
                </span>
              )}
            </>
          )}
        </Badge>

        {/* Show raw pause reason if unknown for debugging */}
        {normalized === "UNKNOWN" && pauseReasonRaw && (
          <p className="text-xs text-muted-foreground">
            Raw value: <code className="bg-muted px-1 rounded">{pauseReasonRaw}</code>
          </p>
        )}

        {/* The explicit decision question */}
        <p className="text-sm font-semibold">
          {config.getQuestion(request)}
        </p>

        {/* Agency says section */}
        {agencyPoints.length > 0 && (
          <div className="bg-muted rounded-md p-3 space-y-2">
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
          <div className="bg-amber-950/30 rounded-md p-3 border border-amber-700/50">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-amber-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-amber-300 mb-1">Recommendation</p>
                <p className="text-sm">{recommendation}</p>
              </div>
            </div>
          </div>
        )}

        {/* Fallback: No recommendation available */}
        {!recommendation && !nextAction && agencyPoints.length === 0 && (
          <div className="bg-muted rounded-md p-3 border border-border">
            <div className="flex items-start gap-2">
              <HelpCircle className="h-4 w-4 text-gray-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1">No recommendation</p>
                <p className="text-xs text-muted-foreground">
                  Not enough context to suggest an action. Review the message and choose an action below.
                </p>
              </div>
            </div>
          </div>
        )}

        <Separator className="bg-border" />

        {/* Unsupported gate warning */}
        {isUnsupported && (
          <div className="bg-yellow-500/10 rounded-md p-3 border border-yellow-700/50">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-yellow-300 mb-1">Actions not yet implemented</p>
                <p className="text-xs text-yellow-400">
                  This gate type ({config.title}) doesn't have automated actions yet. Use the overflow menu to withdraw or take manual action.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Cost cap for fee quotes */}
        {normalized === "FEE_QUOTE" && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Cost cap:</span>
            {showCostCap || costCap ? (
              <div className="flex items-center gap-1">
                <span>$</span>
                <Input
                  type="number"
                  value={costCap}
                  onChange={(e) => setCostCap(e.target.value)}
                  className="w-24 h-7 bg-background"
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
              <div>
                <Button
                  onClick={handleSecondaryClick}
                  variant="default"
                  className="w-full justify-between"
                  disabled={isLoading || isUnsupported}
                >
                  <span className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    {config.secondaryAction.label}
                    <Badge variant="secondary" className="ml-1 text-[10px]">Recommended</Badge>
                  </span>
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <p className="mt-1 text-[11px] text-muted-foreground leading-snug px-0.5">
                  {config.secondaryAction.description}
                </p>
              </div>
              <div>
                <Button
                  onClick={handlePrimaryClick}
                  variant="outline"
                  className="w-full justify-between"
                  disabled={isLoading || isUnsupported}
                >
                  <span className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" />
                    {config.primaryAction.label}
                  </span>
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <p className="mt-1 text-[11px] text-muted-foreground leading-snug px-0.5">
                  {config.primaryAction.description}
                </p>
              </div>
            </>
          )}

          {/* Normal order: Primary first */}
          {!shouldRecommendNegotiate && (
            <>
              <div>
                <Button
                  onClick={handlePrimaryClick}
                  variant="default"
                  className="w-full justify-between"
                  disabled={isLoading || isUnsupported}
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <span className="flex items-center gap-2">
                      <CheckCircle className="h-4 w-4" />
                      {config.primaryAction.label}
                    </span>
                  )}
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <p className="mt-1 text-[11px] text-muted-foreground leading-snug px-0.5">
                  {config.primaryAction.description}
                </p>
              </div>

              {config.secondaryAction && (
                <div>
                  <Button
                    onClick={handleSecondaryClick}
                    variant="outline"
                    className="w-full justify-between"
                    disabled={isLoading || isUnsupported}
                  >
                    <span className="flex items-center gap-2">
                      <MessageSquare className="h-4 w-4" />
                      {config.secondaryAction.label}
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                  <p className="mt-1 text-[11px] text-muted-foreground leading-snug px-0.5">
                    {config.secondaryAction.description}
                  </p>
                </div>
              )}
            </>
          )}

          {/* Overflow menu - always available */}
          {config.overflowActions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full">
                  <MoreHorizontal className="h-4 w-4 mr-2" />
                  More options
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-64">
                {config.overflowActions.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    onClick={() => {
                      if (action.label === "Withdraw" || action.label === "Acknowledge & close") {
                        onWithdraw();
                      } else if (action.label === "Set cost cap") {
                        setShowCostCap(true);
                      } else if (action.label === "Customize negotiation...") {
                        onCustomAdjust?.();
                      } else if (action.label === "Add to phone queue") {
                        onAddToPhoneQueue?.();
                      }
                    }}
                    className="flex flex-col items-start gap-0.5 py-2"
                  >
                    <span className="font-medium text-sm">{action.label}</span>
                    <span className="text-[11px] text-muted-foreground leading-snug whitespace-normal">{action.description}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Inline expandable draft preview */}
        {nextAction?.draft_content && (
          <Collapsible open={draftExpanded} onOpenChange={setDraftExpanded}>
            <CollapsibleTrigger asChild>
              <button className="w-full flex items-center justify-between text-xs text-primary hover:text-primary/80 py-2 border-t border-border mt-2">
                <span className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  View prepared response draft
                </span>
                {draftExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="bg-muted rounded-md p-3 text-sm border border-border">
                <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed">
                  {nextAction.draft_content}
                </pre>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
