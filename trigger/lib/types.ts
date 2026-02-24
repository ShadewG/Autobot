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

export type ActionType =
  | "SEND_INITIAL_REQUEST"
  | "SEND_FOLLOWUP"
  | "SEND_REBUTTAL"
  | "SEND_CLARIFICATION"
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
}

export interface InitialRequestPayload {
  runId: number;
  caseId: number;
  autopilotMode: AutopilotMode;
}

export interface FollowupPayload {
  runId: number;
  caseId: number;
  followupScheduleId: number;
}

export interface CaseContext {
  caseId: number;
  caseData: any;
  messages: any[];
  analysis: any | null;
  followups: any | null;
  existingProposal: any | null;
  autopilotMode: AutopilotMode;
  constraints: string[];
  scopeItems: ScopeItem[];
}

export interface ScopeItem {
  name: string;
  status: string;
  reason: string | null;
  confidence: number | null;
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
