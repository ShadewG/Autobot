"use client";

import type { RequestListItem } from "@/lib/types";
import type { TableVariant } from "./request-table";
import { formatNoResponseAge, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Loader2, Clock, Mail, AlertTriangle, MessageSquare } from "lucide-react";

interface WhyHereChipProps {
  request: RequestListItem;
  variant: TableVariant;
}

function getWhyHereInfo(request: RequestListItem, variant: TableVariant): {
  text: string;
  tone: "blue" | "amber" | "green" | "red";
  icon: "spinner" | "clock" | "mail" | "alert" | "message";
} {
  // Needs Decision bucket
  if (variant === "needs_decision") {
    switch (request.pause_reason) {
      case "FEE_QUOTE":
        return {
          text: request.cost_amount
            ? `Fee quote $${request.cost_amount.toLocaleString()}`
            : "Fee quote received",
          tone: "amber",
          icon: "alert",
        };
      case "DENIAL":
        return { text: "Request denied", tone: "red", icon: "alert" };
      case "SCOPE":
        return { text: "Scope clarification needed", tone: "amber", icon: "alert" };
      case "ID_REQUIRED":
        return { text: "ID verification required", tone: "amber", icon: "alert" };
      case "SENSITIVE":
        return { text: "Sensitive content flagged", tone: "amber", icon: "alert" };
      case "CLOSE_ACTION":
        return { text: "Ready to close", tone: "green", icon: "clock" };
      case "portal_failed":
        return { text: "Portal submission failed", tone: "red", icon: "alert" };
      case "email_send_failed":
        return { text: "Email delivery failed", tone: "red", icon: "mail" };
      case "escalated":
        return { text: "Escalated for review", tone: "amber", icon: "alert" };
      case "agent_run_failed":
        return { text: "Agent error — needs review", tone: "red", icon: "alert" };
      case "stuck_portal_task":
      case "portal_stuck":
        return { text: "Portal task stuck", tone: "amber", icon: "alert" };
      case "portal_timed_out":
        return { text: "Portal timed out", tone: "amber", icon: "clock" };
      case "execution_blocked":
        return { text: "Execution blocked", tone: "red", icon: "alert" };
      case "proposal_pending":
        return { text: "Proposal awaiting review", tone: "amber", icon: "clock" };
      default:
        return { text: "Decision required", tone: "amber", icon: "alert" };
    }
  }

  // Bot Working bucket
  if (variant === "bot_working") {
    if (request.review_state === "DECISION_APPLYING") {
      return { text: "Applying your decision", tone: "blue", icon: "spinner" };
    }
    const runAge = request.active_run_started_at
      ? formatRunAge(request.active_run_started_at)
      : null;
    return {
      text: runAge ? `Agent processing (${runAge})` : "Agent processing",
      tone: "blue",
      icon: "spinner",
    };
  }

  // Waiting on Agency bucket
  if (variant === "waiting") {
    // Has future follow-up scheduled
    if (
      request.due_info?.due_type === "FOLLOW_UP" &&
      request.next_due_at &&
      new Date(request.next_due_at) > new Date()
    ) {
      return {
        text: `Follow-up due ${formatDate(request.next_due_at)}`,
        tone: "blue",
        icon: "clock",
      };
    }

    // Has inbound messages (active correspondence)
    if (request.last_inbound_at) {
      const status = String(request.status || "").toLowerCase();
      if (status === "received_response" || status === "responded") {
        return { text: "Active correspondence", tone: "green", icon: "message" };
      }
    }

    // No response
    return {
      text: formatNoResponseAge(
        request.last_activity_at,
        request.due_info?.statutory_due_at
      ),
      tone: "amber",
      icon: "clock",
    };
  }

  // Completed
  return { text: "Completed", tone: "green", icon: "clock" };
}

function formatRunAge(startedAt: string): string | null {
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return null;
  const mins = Math.floor((Date.now() - started) / (1000 * 60));
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const iconMap = {
  spinner: Loader2,
  clock: Clock,
  mail: Mail,
  alert: AlertTriangle,
  message: MessageSquare,
};

const toneClasses = {
  blue: "text-blue-300",
  amber: "text-amber-300",
  green: "text-emerald-300",
  red: "text-red-300",
};

export function WhyHereChip({ request, variant }: WhyHereChipProps) {
  const info = getWhyHereInfo(request, variant);
  const Icon = iconMap[info.icon];

  return (
    <span
      className={cn(
        "text-xs flex items-center gap-1 font-medium",
        toneClasses[info.tone]
      )}
    >
      {info.icon === "spinner" ? (
        <Icon className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {info.text}
    </span>
  );
}
