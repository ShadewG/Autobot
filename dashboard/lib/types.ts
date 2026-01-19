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
  requires_human: boolean;
  pause_reason: PauseReason | null;
  autopilot_mode: AutopilotMode;
  cost_status: CostStatus;
  cost_amount: number | null;
  at_risk: boolean;
}

// Request Detail - Extended info for detail page
export interface RequestDetail extends RequestListItem {
  case_name: string;
  incident_date: string | null;
  incident_location: string | null;
  requested_records: string;
  additional_details: string | null;
  scope_summary: string;
  portal_url: string | null;
  portal_provider: string | null;
  submitted_at: string | null;
  statutory_due_at: string | null;
  attachments: Attachment[];
}

// Timeline Event for the timeline column
export interface TimelineEvent {
  id: string;
  timestamp: string;
  type: EventType;
  summary: string;
  raw_content?: string;
  ai_audit?: AIAudit;
  attachments?: Attachment[];
}

// AI Audit data shown in timeline events
export interface AIAudit {
  summary: string[];
  policy_rule?: string;
  confidence?: number;
  risk_flags?: string[];
  citations?: { label: string; url?: string }[];
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

// Next Action Proposal from AI
export interface NextAction {
  id: string;
  proposal: string;
  reasoning: string[];
  confidence: number;
  risk_flags: string[];
  can_auto_execute: boolean;
  draft_content?: string;
}

// Agency Summary
export interface AgencySummary {
  id: string;
  name: string;
  state: string;
  submission_method: 'EMAIL' | 'PORTAL' | 'MAIL';
  portal_url?: string;
  default_autopilot_mode: string;
  notes?: string;
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
  | 'PORTAL_TASK';

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
