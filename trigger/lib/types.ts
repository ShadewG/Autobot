export type AutopilotMode = "AUTO" | "SUPERVISED" | "MANUAL";

export type Classification =
  | "FEE_QUOTE"
  | "DENIAL"
  | "ACKNOWLEDGMENT"
  | "RECORDS_READY"
  | "CLARIFICATION_REQUEST"
  | "NO_RESPONSE"
  | "PARTIAL_APPROVAL"
  | "PARTIAL_DELIVERY"
  | "PORTAL_REDIRECT"
  | "WRONG_AGENCY"
  | "HOSTILE"
  | "HUMAN_REVIEW_RESOLUTION"
  | "UNKNOWN";

export type DenialSubtype =
  | "no_records" | "wrong_agency" | "overly_broad" | "ongoing_investigation"
  | "privacy_exemption" | "excessive_fees" | "retention_expired"
  | "glomar_ncnd" | "not_reasonably_described" | "no_duty_to_create"
  | "privilege_attorney_work_product" | "juvenile_records" | "sealed_court_order"
  | "third_party_confidential" | "records_not_yet_created"
  | "format_issue";

export type JurisdictionLevel = "federal" | "state" | "local";
export type ResponseNature = "substantive" | "procedural" | "administrative" | "mixed";
export type ResearchLevel = "none" | "light" | "medium" | "deep";

export interface ResearchContext {
  level: ResearchLevel;
  agency_hierarchy_verified: boolean;
  likely_record_custodians: string[];
  official_records_submission_methods: string[];
  portal_url_verified: boolean;
  state_law_notes: string | null;
  record_type_handoff_notes: string | null;
  rebuttal_support_points: string[];
  clarification_answer_support: string | null;
  cached_at: string | null;
}

export type ActionType =
  | "SEND_INITIAL_REQUEST"
  | "SEND_FOLLOWUP"
  | "SEND_REBUTTAL"
  | "SEND_CLARIFICATION"
  | "SEND_APPEAL"
  | "SEND_FEE_WAIVER_REQUEST"
  | "SEND_STATUS_UPDATE"
  | "RESPOND_PARTIAL_APPROVAL"
  | "ACCEPT_FEE"
  | "NEGOTIATE_FEE"
  | "DECLINE_FEE"
  | "ESCALATE"
  | "NONE"
  | "CLOSE_CASE"
  | "WITHDRAW"
  | "RESEARCH_AGENCY"
  | "REFORMULATE_REQUEST"
  | "SUBMIT_PORTAL"
  | "SEND_PDF_EMAIL";

export type HumanDecisionAction = "APPROVE" | "ADJUST" | "DISMISS" | "WITHDRAW";

export interface HumanDecision {
  action: HumanDecisionAction;
  instruction?: string;
  route_mode?: string;
}

export interface InboundPayload {
  runId: number;
  caseId: number;
  messageId: number;
  autopilotMode: AutopilotMode;
  // Human review resolution context (when human resolves a review action from dashboard)
  triggerType?: string;
  reviewAction?: string;
  reviewInstruction?: string;
  // Adjustment context (when human clicks ADJUST on a proposal)
  originalActionType?: string;
  originalProposalId?: number;
}

export interface InitialRequestPayload {
  runId: number;
  caseId: number;
  autopilotMode: AutopilotMode;
  // Adjustment context (when human clicks ADJUST on a proposal)
  triggerType?: string;
  reviewAction?: string;
  reviewInstruction?: string;
  originalActionType?: string;
  originalProposalId?: number;
}

export interface FollowupPayload {
  runId: number;
  caseId: number;
  followupScheduleId: number | null;
}

export interface DecisionHistoryEntry {
  action_taken: string;
  reasoning: string;
  outcome: string;
  created_at: string;
}

export interface PortalTaskHistoryEntry {
  status: string;
  completion_notes: string;
  portal_url: string;
  created_at: string;
}

export interface FeeEventEntry {
  event_type: string;
  amount: number | null;
  notes: string;
  created_at: string;
}

export interface DismissedProposalEntry {
  action_type: string;
  reasoning: string[];
  human_decision: any;
  created_at: string;
  dismiss_count: number;
}

export interface CaseContext {
  caseId: number;
  caseData: any;
  messages: any[];
  attachments: any[];
  analysis: any | null;
  followups: any | null;
  existingProposal: any | null;
  autopilotMode: AutopilotMode;
  constraints: string[];
  scopeItems: ScopeItem[];
  decisionHistory?: DecisionHistoryEntry[];
  portalTaskHistory?: PortalTaskHistoryEntry[];
  feeEvents?: FeeEventEntry[];
  dismissedProposals?: DismissedProposalEntry[];
}

export interface ScopeItem {
  name: string;
  status: string;
  reason: string | null;
  confidence: number | null;
}

export interface ReferralContact {
  agency_name: string | null;
  email: string | null;
  phone: string | null;
  url: string | null;
  notes: string | null;
}

export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  sentiment: string;
  extractedFeeAmount: number | null;
  extractedDeadline: string | null;
  denialSubtype: string | null;
  requiresResponse: boolean;
  portalUrl: string | null;
  suggestedAction: string | null;
  reasonNoResponse: string | null;
  unansweredAgencyQuestion: string | null;
  jurisdiction_level?: JurisdictionLevel | null;
  response_nature?: ResponseNature | null;
  detected_exemption_citations?: string[];
  decision_evidence_quotes?: string[];
  referralContact?: ReferralContact | null;
  keyPoints?: string[];
}

export interface DecisionResult {
  actionType: ActionType;
  canAutoExecute: boolean;
  requiresHuman: boolean;
  pauseReason: string | null;
  reasoning: string[];
  adjustmentInstruction: string | null;
  isComplete: boolean;
  gateOptions?: string[];
  // For clarification override: redirect to a different inbound message
  overrideMessageId?: number;
  researchLevel?: ResearchLevel;
}

export interface DraftResult {
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  lessonsApplied: any[];
  researchContactResult?: any;
  researchBrief?: any;
  [key: string]: any;
}

export interface SafetyResult {
  riskFlags: string[];
  warnings: string[];
  canAutoExecute: boolean;
  requiresHuman: boolean;
  pauseReason: string | null;
}

export interface ProposalRecord {
  id: number;
  proposal_key: string;
  case_id: number;
  run_id: number | null;
  action_type: ActionType;
  status: string;
  draft_subject: string | null;
  draft_body_text: string | null;
  draft_body_html: string | null;
  reasoning: string[];
  can_auto_execute: boolean;
  requires_human: boolean;
  waitpoint_token: string | null;
  version: number;
  execution_key: string | null;
}

export interface ExecutionResult {
  action: string;
  emailJobId?: string;
  escalationId?: number;
  portalTaskId?: number;
  [key: string]: any;
}
