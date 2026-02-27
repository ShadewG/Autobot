import type {
  RequestDetail,
  RequestWorkspaceResponse,
  NextAction,
  AgencySummary,
  TimelineEvent,
  ThreadMessage,
  DueInfo,
  PauseReason,
  AutopilotMode,
  ReviewState,
  AgentRunSummary,
} from "@/lib/types";

/**
 * Pre-computed view model for request display.
 * All derived fields computed ONCE here, not in individual components.
 */
export interface RequestVM {
  // Identity
  id: string;
  title: string; // "Request #123 — Eric Banks BWC"
  agencyName: string;

  // Status
  status: string;
  statusLabel: string;
  isPaused: boolean;
  pauseReason: PauseReason | null;
  pauseReasonLabel: string | null;
  autopilotMode: AutopilotMode;
  autopilotLabel: string;

  // Why paused (deterministic single-line)
  whyPausedText: string | null;

  // Due info (pre-computed)
  due: {
    nextDueAt: string | null;
    dueType: string | null;
    dueTypeLabel: string;
    statutoryDueAt: string | null;
    statutoryDays: number | null;
    isOverdue: boolean;
    overdueDays: number | null;
    isAtRisk: boolean; // within 48h
    formattedDueDate: string;
    snoozedUntil: string | null;
  };

  // Dates (pre-formatted)
  submittedAt: string | null;
  submittedAtFormatted: string;
  lastInboundAt: string | null;
  lastInboundAtFormatted: string;

  // Cost
  costAmount: number | null;
  costAmountFormatted: string;
  costStatus: string;
  hasFeeQuote: boolean;

  // Recipient (for approval display)
  channel: "EMAIL" | "PORTAL" | "MAIL";
  recipientEmail: string | null;
  portalProvider: string | null;
  isPortal: boolean;

  // Review state (derived server-side)
  reviewState: ReviewState | null;
  isDecisionRequired: boolean;
  isDecisionApplying: boolean;

  // Quick access
  hasInboundMessages: boolean;
  lastInboundMessageId: string | null;
  hasDraft: boolean;
}

export interface WorkspaceVM {
  request: RequestVM;
  // Raw data still available for components that need it
  rawRequest: RequestDetail;
  timelineEvents: TimelineEvent[];
  threadMessages: ThreadMessage[];
  nextAction: NextAction | null;
  agency: AgencySummary;
  activeRun: AgentRunSummary | null;

  // Filtered/computed lists
  inboundMessages: ThreadMessage[];
  outboundMessages: ThreadMessage[];
  decisionEvents: TimelineEvent[];
  agentAuditEvents: TimelineEvent[];
}

// Labels
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  READY_TO_SEND: "Ready to Send",
  AWAITING_RESPONSE: "Awaiting Response",
  RECEIVED_RESPONSE: "Response Received",
  CLOSED: "Closed",
  NEEDS_HUMAN_REVIEW: "Paused",
  ID_STATE: "ID State",
};

const PAUSE_REASON_LABELS: Record<string, string> = {
  FEE_QUOTE: "Fee Quote",
  SCOPE: "Scope Issue",
  DENIAL: "Denial",
  ID_REQUIRED: "ID Required",
  SENSITIVE: "Sensitive",
  CLOSE_ACTION: "Close Action",
  UNSPECIFIED: "Needs Review",
};

const AUTOPILOT_LABELS: Record<string, string> = {
  AUTO: "Auto",
  SUPERVISED: "Supervised",
  MANUAL: "Manual",
};

const DUE_TYPE_LABELS: Record<string, string> = {
  FOLLOW_UP: "Follow-up due",
  STATUTORY: "Statutory deadline",
  AGENCY_PROMISED: "Agency promised",
  SNOOZED: "Snoozed until",
};

// Formatters
function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Build the "why paused" text deterministically
 */
function buildWhyPausedText(
  pauseReason: PauseReason | null,
  costAmount: number | null,
  autopilotMode: AutopilotMode,
  feeThreshold: number | null,
  alwaysHumanGates: PauseReason[],
  blockedReason?: string
): string | null {
  if (!pauseReason) return null;

  switch (pauseReason) {
    case "FEE_QUOTE":
      if (costAmount && feeThreshold !== null) {
        return `Paused: Fee ${formatCurrency(costAmount)} exceeds ${formatCurrency(feeThreshold)} threshold (autopilot: ${AUTOPILOT_LABELS[autopilotMode]})`;
      }
      if (costAmount) {
        return `Paused: Fee ${formatCurrency(costAmount)} requires approval (autopilot: ${AUTOPILOT_LABELS[autopilotMode]})`;
      }
      return `Paused: Fee quote requires approval (autopilot: ${AUTOPILOT_LABELS[autopilotMode]})`;

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

/**
 * Compute due info with all derived fields
 */
function computeDueInfo(
  dueInfo?: DueInfo,
  nextDueAt?: string | null,
  statutoryDueAt?: string | null
): RequestVM["due"] {
  const info: DueInfo = dueInfo || {
    next_due_at: nextDueAt || null,
    due_type: nextDueAt ? "FOLLOW_UP" : null,
    statutory_days: null,
    statutory_due_at: statutoryDueAt || null,
    snoozed_until: null,
    is_overdue: false,
    overdue_days: null,
  };

  const now = new Date();
  let isOverdue = false;
  let overdueDays: number | null = null;
  let isAtRisk = false;

  if (info.next_due_at) {
    const dueDate = new Date(info.next_due_at);
    if (!isNaN(dueDate.getTime())) {
      const diffMs = dueDate.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      isOverdue = diffMs < 0;
      if (isOverdue) {
        overdueDays = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60 * 24));
      }
      isAtRisk = !isOverdue && diffHours <= 48;
    }
  }

  return {
    nextDueAt: info.next_due_at,
    dueType: info.due_type,
    dueTypeLabel: info.due_type ? DUE_TYPE_LABELS[info.due_type] || info.due_type : "—",
    statutoryDueAt: info.statutory_due_at,
    statutoryDays: info.statutory_days,
    isOverdue,
    overdueDays,
    isAtRisk,
    formattedDueDate: formatDate(info.next_due_at),
    snoozedUntil: info.snoozed_until,
  };
}

/**
 * Transform RequestDetail → RequestVM
 */
export function toRequestVM(
  request: RequestDetail,
  agency?: AgencySummary,
  nextAction?: NextAction | null
): RequestVM {
  const rules = agency?.rules;
  const feeThreshold = rules?.fee_auto_approve_threshold ?? null;
  const alwaysHumanGates = rules?.always_human_gates || [];

  const channel = nextAction?.channel || agency?.submission_method || "EMAIL";
  const inboundMessages: ThreadMessage[] = []; // Not available at this level

  return {
    id: request.id,
    title: `Request #${request.id} — ${request.subject}`,
    agencyName: request.agency_name,

    status: request.status,
    statusLabel: STATUS_LABELS[request.status] || request.status,
    isPaused: request.requires_human,
    pauseReason: request.pause_reason,
    pauseReasonLabel: request.pause_reason ? PAUSE_REASON_LABELS[request.pause_reason] : null,
    autopilotMode: request.autopilot_mode,
    autopilotLabel: AUTOPILOT_LABELS[request.autopilot_mode] || request.autopilot_mode,

    whyPausedText: request.requires_human
      ? buildWhyPausedText(
          request.pause_reason,
          request.cost_amount,
          request.autopilot_mode,
          feeThreshold,
          alwaysHumanGates,
          nextAction?.blocked_reason
        )
      : null,

    due: computeDueInfo(request.due_info, request.next_due_at, request.statutory_due_at),

    submittedAt: request.submitted_at,
    submittedAtFormatted: formatDate(request.submitted_at),
    lastInboundAt: request.last_inbound_at,
    lastInboundAtFormatted: formatDate(request.last_inbound_at),

    costAmount: request.cost_amount,
    costAmountFormatted: formatCurrency(request.cost_amount),
    costStatus: request.cost_status,
    hasFeeQuote: request.cost_status !== "NONE" && request.cost_amount !== null,

    channel: channel as "EMAIL" | "PORTAL" | "MAIL",
    recipientEmail: nextAction?.recipient_email || request.agency_email || null,
    portalProvider: nextAction?.portal_provider || agency?.portal_provider || null,
    isPortal: channel === "PORTAL",

    reviewState: null, // Set at workspace level from API response
    isDecisionRequired: false, // Set at workspace level
    isDecisionApplying: false, // Set at workspace level

    hasInboundMessages: false, // Set at workspace level
    lastInboundMessageId: null, // Set at workspace level
    hasDraft: !!nextAction?.draft_content,
  };
}

/**
 * Transform full workspace response → WorkspaceVM
 */
export function toWorkspaceVM(data: RequestWorkspaceResponse): WorkspaceVM {
  const { request, timeline_events, thread_messages, next_action_proposal, agency_summary } = data;

  const inboundMessages = thread_messages.filter((m) => m.direction === "INBOUND");
  const outboundMessages = thread_messages.filter((m) => m.direction === "OUTBOUND");
  const decisionEvents = timeline_events.filter((e) =>
    ["FEE_QUOTE", "DENIAL", "GATE_TRIGGERED", "PROPOSAL_QUEUED", "HUMAN_DECISION", "SENT", "RECEIVED"].includes(e.type)
  );
  const agentAuditEvents = timeline_events.filter((e) => e.ai_audit);

  const requestVM = toRequestVM(request, agency_summary, next_action_proposal);

  // Enhance with workspace-level data
  const reviewState = data.review_state ?? null;
  requestVM.reviewState = reviewState;
  requestVM.isDecisionRequired = reviewState === 'DECISION_REQUIRED';
  requestVM.isDecisionApplying = reviewState === 'DECISION_APPLYING';
  requestVM.hasInboundMessages = inboundMessages.length > 0;
  requestVM.lastInboundMessageId = inboundMessages.length > 0
    ? String(inboundMessages[inboundMessages.length - 1].id)
    : null;

  return {
    request: requestVM,
    rawRequest: request,
    timelineEvents: timeline_events,
    threadMessages: thread_messages,
    nextAction: next_action_proposal,
    agency: agency_summary,
    activeRun: data.active_run ?? null,
    inboundMessages,
    outboundMessages,
    decisionEvents,
    agentAuditEvents,
  };
}
