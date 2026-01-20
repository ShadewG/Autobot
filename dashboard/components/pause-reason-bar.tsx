"use client";

import { Info } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { PauseReason, AutopilotMode, AgencyRules } from "@/lib/types";

interface PauseReasonBarProps {
  pauseReason: PauseReason | null;
  costAmount?: number | null;
  autopilotMode: AutopilotMode;
  agencyRules?: AgencyRules;
  blockedReason?: string;
}

/**
 * Single-line deterministic explanation of why a request is paused.
 * Makes the "why" painfully obvious.
 */
export function PauseReasonBar({
  pauseReason,
  costAmount,
  autopilotMode,
  agencyRules,
  blockedReason,
}: PauseReasonBarProps) {
  if (!pauseReason) return null;

  const reasonText = buildReasonText({
    pauseReason,
    costAmount,
    autopilotMode,
    agencyRules,
    blockedReason,
  });

  return (
    <div className="flex items-center gap-2 text-sm bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded px-3 py-1.5">
      <Info className="h-3.5 w-3.5 text-yellow-600 flex-shrink-0" />
      <span className="text-yellow-800 dark:text-yellow-200">{reasonText}</span>
    </div>
  );
}

function buildReasonText({
  pauseReason,
  costAmount,
  autopilotMode,
  agencyRules,
  blockedReason,
}: {
  pauseReason: PauseReason;
  costAmount?: number | null;
  autopilotMode: AutopilotMode;
  agencyRules?: AgencyRules;
  blockedReason?: string;
}): string {
  const threshold = agencyRules?.fee_auto_approve_threshold;
  const alwaysHumanGates = agencyRules?.always_human_gates || [];

  switch (pauseReason) {
    case "FEE_QUOTE":
      if (costAmount && threshold !== null && threshold !== undefined) {
        return `Paused: Fee ${formatCurrency(costAmount)} exceeds ${formatCurrency(threshold)} threshold (autopilot: ${autopilotMode})`;
      }
      if (costAmount) {
        return `Paused: Fee ${formatCurrency(costAmount)} requires approval (autopilot: ${autopilotMode})`;
      }
      return `Paused: Fee quote requires approval (autopilot: ${autopilotMode})`;

    case "DENIAL":
      if (alwaysHumanGates.includes("DENIAL")) {
        return `Paused: Denial is an always-human gate`;
      }
      return `Paused: Denial requires human decision`;

    case "SCOPE":
      if (alwaysHumanGates.includes("SCOPE")) {
        return `Paused: Scope change is an always-human gate`;
      }
      return `Paused: Scope change requires approval`;

    case "ID_REQUIRED":
      return `Paused: Agency requires ID verification`;

    case "SENSITIVE":
      if (blockedReason) {
        return `Paused: ${blockedReason}`;
      }
      return `Paused: Flagged as sensitive — requires human review`;

    case "CLOSE_ACTION":
      return `Paused: Ready to close — confirm completion`;

    default:
      if (blockedReason) {
        return `Paused: ${blockedReason}`;
      }
      return `Paused: Requires human review`;
  }
}
