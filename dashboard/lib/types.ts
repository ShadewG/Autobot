// Due date information with context
export interface DueInfo {
  next_due_at: string | null;
  due_type: 'FOLLOW_UP' | 'STATUTORY' | 'AGENCY_PROMISED' | 'SNOOZED' | null;
  statutory_days: number | null; // e.g., 10 or 20 business days
  statutory_due_at: string | null;
  snoozed_until: string | null;
  is_overdue: boolean;
  overdue_days: number | null;
}

// Request List Item - Used in inbox tables
export interface RequestListItem {
  id: string;
  subject: string;
  agency_name: string;
  state: string;
  status: RequestStatus;
  last_inbound_at: string | null;
  last_activity_at: string;
  next_due_at: string | null;
  due_info?: DueInfo;
  requires_human: boolean;
  pause_reason: PauseReason | null;
  autopilot_mode: AutopilotMode;
  cost_status: CostStatus;
  cost_amount: number | null;
  at_risk: boolean;
}

// Scope item with availability status
export interface ScopeItem {
  name: string;
  status: 'REQUESTED' | 'CONFIRMED_AVAILABLE' | 'NOT_DISCLOSABLE' | 'NOT_HELD' | 'PENDING';
  reason?: string; // e.g., "SC § 23-1-240(B)" or "Agency confirmed not held"
  confidence?: number;
}

// Detected constraint from agency or statute
export interface Constraint {
  type: 'EXEMPTION' | 'NOT_HELD' | 'REDACTION_REQUIRED' | 'FEE_REQUIRED';
  description: string;
  source: string; // e.g., "Agency response" or "SC § 23-1-240(B)"
  confidence: number;
  affected_items: string[];
}

// Fee quote details
export interface FeeQuote {
  amount: number;
  currency: string;
  quoted_at: string | null;
  status: 'NONE' | 'QUOTED' | 'INVOICED' | 'APPROVED' | 'PAID';
  deposit_amount?: number | null;
  breakdown?: { item: string; amount: number }[];
  waiver_possible?: boolean;
  notes?: string;
  valid_until?: string;
}

// Request Detail - Extended info for detail page
export interface RequestDetail extends RequestListItem {
  case_name: string;
  incident_date: string | null;
  incident_location: string | null;
  requested_records: string;
  additional_details: string | null;
  scope_summary: string;
  scope_items?: ScopeItem[];
  constraints?: Constraint[];
  fee_quote?: FeeQuote;
  portal_url: string | null;
  portal_provider: string | null;
  submitted_at: string | null;
  statutory_due_at: string | null;
  attachments: Attachment[];
  // Recipient info
  agency_email: string | null;
  // External links
  notion_url: string | null;
}

// Timeline Event for the timeline column
export interface TimelineEvent {
  id: string;
  timestamp: string;
  type: EventType;
  category: 'MESSAGE' | 'STATUS' | 'COST' | 'RESEARCH' | 'AGENT' | 'GATE';
  summary: string;
  raw_content?: string;
  ai_audit?: AIAudit;
  attachments?: Attachment[];
  // For gate events
  gate_details?: {
    gate_type: PauseReason;
    fee_amount?: number;
    deposit_amount?: number;
    decision_status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MODIFIED';
  };
  // For message classification
  classification?: {
    type: string; // e.g., "FEE_QUOTE", "ACKNOWLEDGMENT", "DENIAL"
    confidence: number;
  };
}

// AI Audit data shown in timeline events
export interface AIAudit {
  summary: string[];
  policy_rule?: string;
  confidence?: number;
  risk_flags?: string[];
  citations?: { label: string; url?: string }[];
  statute_matches?: { statute: string; confidence: number }[];
}

// Thread Message for conversation view
export interface ThreadMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  channel: 'EMAIL' | 'PORTAL' | 'MAIL' | 'CALL';
  from_email: string;
  to_email: string;
  subject: string;
  body: string;
  sent_at: string;
  attachments: Attachment[];
}

// Action types for NextAction
export type ActionType =
  | 'SEND_EMAIL'
  | 'SEND_PORTAL'
  | 'FEE_NEGOTIATION'
  | 'FOLLOW_UP'
  | 'SCOPE_CLARIFICATION'
  | 'APPEAL'
  | 'ACCEPTANCE'
  | 'WITHDRAWAL'
  | 'ESCALATE'
  | 'NARROW_SCOPE'
  | 'CUSTOM';

// Next Action Proposal from AI
export interface NextAction {
  id: string;
  action_type: ActionType;
  proposal: string;
  proposal_short?: string; // e.g., "Fee Negotiation Email" - for button text
  reasoning: string[];
  confidence: number;
  risk_flags: string[];
  warnings?: string[]; // e.g., "This commits to paying $75 deposit"
  can_auto_execute: boolean;
  blocked_reason?: string; // Why it can't auto-execute
  draft_content?: string;
  draft_preview?: string; // First 2-3 lines for button hover
  constraints_applied?: string[]; // Which constraints were considered
  // Recipient info for trust
  channel: 'EMAIL' | 'PORTAL' | 'MAIL';
  recipient_email?: string; // e.g., "rclerk@normanok.gov"
  portal_provider?: string; // e.g., "GovQA", "NextRequest"
  // Scheduling info
  scheduled_send_at?: string; // ISO timestamp when it will be sent
  status?: 'PENDING' | 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'BLOCKED';
}

// Agency automation rules
export interface AgencyRules {
  fee_auto_approve_threshold: number | null;
  always_human_gates: PauseReason[];
  known_exemptions: string[]; // e.g., ["BWC exempt per SC § 23-1-240(B)"]
  typical_response_days: number | null;
}

// Agency Summary
export interface AgencySummary {
  id: string;
  name: string;
  state: string;
  submission_method: 'EMAIL' | 'PORTAL' | 'MAIL';
  portal_url?: string;
  portal_provider?: string; // e.g., "GovQA", "NextRequest"
  default_autopilot_mode: string;
  notes?: string;
  rules?: AgencyRules;
}

// Attachment
export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  url?: string;
}

// Request Workspace - Combined data for detail page
export interface RequestWorkspace {
  request: RequestDetail;
  timeline_events: TimelineEvent[];
  thread_messages: ThreadMessage[];
  next_action_proposal: NextAction | null;
  agency_summary: AgencySummary;
}

// Enums
export type RequestStatus =
  | 'DRAFT'
  | 'READY_TO_SEND'
  | 'AWAITING_RESPONSE'
  | 'RECEIVED_RESPONSE'
  | 'CLOSED'
  | 'NEEDS_HUMAN_REVIEW';

export type PauseReason =
  | 'FEE_QUOTE'
  | 'SCOPE'
  | 'DENIAL'
  | 'ID_REQUIRED'
  | 'SENSITIVE'
  | 'CLOSE_ACTION';

export type AutopilotMode = 'AUTO' | 'SUPERVISED' | 'MANUAL';

export type CostStatus = 'NONE' | 'QUOTED' | 'INVOICED' | 'APPROVED' | 'PAID';

export type EventType =
  | 'CREATED'
  | 'SENT'
  | 'RECEIVED'
  | 'FEE_QUOTE'
  | 'DENIAL'
  | 'FOLLOW_UP'
  | 'PORTAL_TASK'
  | 'GATE_TRIGGERED'
  | 'PROPOSAL_QUEUED'
  | 'HUMAN_DECISION'
  | 'CONSTRAINT_DETECTED'
  | 'SCOPE_UPDATED';

// Agency List Item
export interface AgencyListItem {
  id: string;
  name: string;
  state: string;
  submission_method: 'EMAIL' | 'PORTAL' | 'MAIL';
  portal_url: string | null;
  portal_provider: string | null;
  default_autopilot_mode: string;
  total_requests: number;
  completed_requests: number;
  avg_response_days: number | null;
  last_activity_at: string | null;
  notes: string | null;
}

// Agency Detail
export interface AgencyDetail extends AgencyListItem {
  stats: {
    total_requests: number;
    completed_requests: number;
    pending_review: number;
    has_fees: number;
    total_fees: number;
    avg_response_days: number | null;
    first_request_at: string | null;
    last_activity_at: string | null;
  };
  recent_requests: {
    id: string;
    case_name: string;
    subject_name: string;
    status: string;
    send_date: string | null;
    last_response_date: string | null;
  }[];
  submission_details: {
    forms_required: boolean;
    id_required: boolean;
    notarization_required: boolean;
  };
  fee_behavior: {
    typical_fee_range: string | null;
    waiver_success_rate: number | null;
  };
}

// API Response types
export interface RequestsListResponse {
  success: boolean;
  count: number;
  paused_count: number;
  ongoing_count: number;
  requests: RequestListItem[];
}

export interface RequestWorkspaceResponse {
  success: boolean;
  request: RequestDetail;
  timeline_events: TimelineEvent[];
  thread_messages: ThreadMessage[];
  next_action_proposal: NextAction | null;
  agency_summary: AgencySummary;
}

export interface AgenciesListResponse {
  success: boolean;
  count: number;
  agencies: AgencyListItem[];
}

export interface AgencyDetailResponse {
  success: boolean;
  agency: AgencyDetail;
}
