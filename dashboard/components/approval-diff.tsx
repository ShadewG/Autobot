"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { NextAction, FeeQuote, ScopeItem } from "@/lib/types";

interface ApprovalDiffProps {
  nextAction: NextAction;
  feeQuote?: FeeQuote | null;
  scopeItems?: ScopeItem[];
  costCap?: number | null;
  recipientEmail?: string;
  channel?: 'EMAIL' | 'PORTAL' | 'MAIL';
  portalProvider?: string;
}

/**
 * Micro-diff showing what changes if user approves.
 * Assembled from warnings, risk_flags, constraints_applied, cost_status, scope_items.
 */
export function ApprovalDiff({
  nextAction,
  feeQuote,
  scopeItems,
  costCap,
  recipientEmail,
  channel,
  portalProvider,
}: ApprovalDiffProps) {
  const [expanded, setExpanded] = useState(false);

  const willDo: string[] = [];
  const willNotDo: string[] = [];

  // Build "will do" items based on action type and context

  // Show where the message is going (critical for trust)
  const actualChannel = channel || nextAction.channel;
  const actualRecipient = recipientEmail || nextAction.recipient_email;
  const actualPortal = portalProvider || nextAction.portal_provider;

  if (actualChannel === "EMAIL" && actualRecipient) {
    willDo.push(`Send email to ${actualRecipient}`);
  } else if (actualChannel === "PORTAL") {
    willDo.push(`Submit via ${actualPortal || "portal"}`);
  } else if (actualChannel === "MAIL") {
    willDo.push("Send physical mail");
  } else if (nextAction.action_type === "SEND_EMAIL" || nextAction.action_type === "SEND_PORTAL") {
    willDo.push("Send message to agency");
  }

  if (nextAction.action_type === "FEE_NEGOTIATION" || nextAction.action_type === "ACCEPTANCE") {
    if (feeQuote?.deposit_amount) {
      willDo.push(`Accept ${formatCurrency(feeQuote.deposit_amount)} deposit`);
    } else if (feeQuote?.amount) {
      willDo.push(`Accept ${formatCurrency(feeQuote.amount)} fee`);
    }
  }

  if (nextAction.action_type === "FOLLOW_UP") {
    willDo.push("Send follow-up message");
  }

  if (nextAction.action_type === "APPEAL") {
    willDo.push("File an appeal");
  }

  if (nextAction.action_type === "NARROW_SCOPE") {
    willDo.push("Narrow request scope");
  }

  // Add from constraints_applied
  if (nextAction.constraints_applied?.length) {
    nextAction.constraints_applied.forEach((c) => {
      if (c.toLowerCase().includes("scope")) {
        willDo.push("Keep scope as-is");
      }
    });
  }

  // Add from warnings
  if (nextAction.warnings?.length) {
    nextAction.warnings.forEach((w) => {
      if (w.toLowerCase().includes("commit") || w.toLowerCase().includes("pay")) {
        willDo.push(w);
      }
    });
  }

  // Build "will not do" items
  const unavailableItems = scopeItems?.filter(
    (s) => s.status === "NOT_DISCLOSABLE" || s.status === "NOT_HELD"
  );
  if (unavailableItems?.length) {
    willNotDo.push(`Request unavailable items (${unavailableItems.map(s => s.name).join(", ")})`);
  }

  if (costCap) {
    willNotDo.push(`Exceed ${formatCurrency(costCap)} cost cap`);
  }

  // Risk flags as "will not" (things we're avoiding)
  if (nextAction.risk_flags?.length) {
    nextAction.risk_flags.forEach((flag) => {
      if (flag.toLowerCase().includes("waive") || flag.toLowerCase().includes("skip")) {
        willNotDo.push(flag);
      }
    });
  }

  // Don't render if nothing to show
  if (willDo.length === 0 && willNotDo.length === 0) {
    return null;
  }

  return (
    <div className="border rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        What changes if I approve?
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {willDo.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                This will:
              </p>
              {willDo.map((item, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <Check className="h-3 w-3 text-green-400 mt-0.5 flex-shrink-0" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          )}

          {willNotDo.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                This will not:
              </p>
              {willNotDo.map((item, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <X className="h-3 w-3 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <span className="text-muted-foreground">{item}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
