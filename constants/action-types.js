/**
 * Canonical Action Types
 *
 * Single source of truth for all action types used throughout the system.
 * Use these constants everywhere: router output, proposal.action_type, UI labels.
 *
 * DO NOT add new action types without updating:
 * 1. This file
 * 2. UI labels (if applicable)
 * 3. Test fixtures
 */

// Send actions - email/message sending
const SEND_INITIAL_REQUEST = 'SEND_INITIAL_REQUEST';
const SEND_FOLLOWUP = 'SEND_FOLLOWUP';
const SEND_REBUTTAL = 'SEND_REBUTTAL';
const SEND_CLARIFICATION = 'SEND_CLARIFICATION';
const RESPOND_PARTIAL_APPROVAL = 'RESPOND_PARTIAL_APPROVAL';  // Accept released + challenge withheld

// Fee actions - responding to fee quotes
const ACCEPT_FEE = 'ACCEPT_FEE';        // Use this, NOT APPROVE_FEE
const NEGOTIATE_FEE = 'NEGOTIATE_FEE';
const DECLINE_FEE = 'DECLINE_FEE';

// Other actions
const ESCALATE = 'ESCALATE';
const NONE = 'NONE';                     // No action needed
const CLOSE_CASE = 'CLOSE_CASE';
const WITHDRAW = 'WITHDRAW';

// Research/reformulation actions
const RESEARCH_AGENCY = 'RESEARCH_AGENCY';          // Re-research correct agency/contact
const REFORMULATE_REQUEST = 'REFORMULATE_REQUEST';  // Rewrite request differently
const SUBMIT_PORTAL = 'SUBMIT_PORTAL';              // Submit via portal (already used in code, now canonical)
const SEND_PDF_EMAIL = 'SEND_PDF_EMAIL';            // Portal fallback: send PDF attachment via email

/**
 * All valid action types
 */
const ACTION_TYPES = [
  SEND_INITIAL_REQUEST,
  SEND_FOLLOWUP,
  SEND_REBUTTAL,
  SEND_CLARIFICATION,
  RESPOND_PARTIAL_APPROVAL,
  ACCEPT_FEE,
  NEGOTIATE_FEE,
  DECLINE_FEE,
  ESCALATE,
  NONE,
  CLOSE_CASE,
  WITHDRAW,
  RESEARCH_AGENCY,
  REFORMULATE_REQUEST,
  SUBMIT_PORTAL,
  SEND_PDF_EMAIL
];

/**
 * Action types that require drafting an email/message
 */
const DRAFT_REQUIRED_ACTIONS = [
  SEND_INITIAL_REQUEST,
  SEND_FOLLOWUP,
  SEND_REBUTTAL,
  SEND_CLARIFICATION,
  RESPOND_PARTIAL_APPROVAL,
  ACCEPT_FEE,
  NEGOTIATE_FEE,
  DECLINE_FEE
];

/**
 * Action types that always require human approval (never auto-execute)
 */
const ALWAYS_GATE_ACTIONS = [
  ESCALATE,
  CLOSE_CASE,
  WITHDRAW,
  RESEARCH_AGENCY,
  REFORMULATE_REQUEST,
  SUBMIT_PORTAL,
  SEND_PDF_EMAIL
];

/**
 * Action types that can auto-execute in AUTO mode
 */
const AUTO_EXECUTE_ACTIONS = [
  SEND_FOLLOWUP,
  SEND_REBUTTAL,
  SEND_CLARIFICATION,
  ACCEPT_FEE
];

/**
 * Human-readable labels for UI
 */
const ACTION_LABELS = {
  [SEND_INITIAL_REQUEST]: 'Send Initial Request',
  [SEND_FOLLOWUP]: 'Send Follow-up',
  [SEND_REBUTTAL]: 'Send Denial Rebuttal',
  [SEND_CLARIFICATION]: 'Send Clarification',
  [RESPOND_PARTIAL_APPROVAL]: 'Respond to Partial Approval',
  [ACCEPT_FEE]: 'Accept Fee',
  [NEGOTIATE_FEE]: 'Negotiate Fee',
  [DECLINE_FEE]: 'Decline Fee',
  [ESCALATE]: 'Escalate to Human',
  [NONE]: 'No Action Needed',
  [CLOSE_CASE]: 'Close Case',
  [WITHDRAW]: 'Withdraw Request',
  [RESEARCH_AGENCY]: 'Research Correct Agency',
  [REFORMULATE_REQUEST]: 'Reformulate Request',
  [SUBMIT_PORTAL]: 'Submit via Portal',
  [SEND_PDF_EMAIL]: 'Send PDF via Email'
};

/**
 * Legacy action type mapping (for backwards compatibility)
 * Maps old/inconsistent names to canonical names
 */
const LEGACY_ACTION_MAP = {
  'APPROVE_FEE': ACCEPT_FEE,        // Old name
  'FEE_ACCEPT': ACCEPT_FEE,
  'FEE_NEGOTIATE': NEGOTIATE_FEE,
  'FEE_DECLINE': DECLINE_FEE,
  'INITIAL_REQUEST': SEND_INITIAL_REQUEST,
  'FOLLOWUP': SEND_FOLLOWUP,
  'REBUTTAL': SEND_REBUTTAL,
  'CLARIFICATION': SEND_CLARIFICATION
};

/**
 * Validate an action type
 * @param {string} actionType - The action type to validate
 * @returns {boolean} True if valid
 */
function isValidActionType(actionType) {
  return ACTION_TYPES.includes(actionType);
}

/**
 * Normalize an action type (handles legacy names)
 * @param {string} actionType - The action type to normalize
 * @returns {string} Canonical action type
 * @throws {Error} If action type is unknown
 */
function normalizeActionType(actionType) {
  if (!actionType) {
    throw new Error('Action type is required');
  }

  // Check if it's already canonical
  if (ACTION_TYPES.includes(actionType)) {
    return actionType;
  }

  // Check legacy mapping
  const normalized = LEGACY_ACTION_MAP[actionType];
  if (normalized) {
    return normalized;
  }

  // Unknown action type
  throw new Error(`Unknown action type: ${actionType}. Valid types: ${ACTION_TYPES.join(', ')}`);
}

/**
 * Validate and get action type (throws on invalid)
 * Use this in router output and proposal creation
 */
function validateActionType(actionType) {
  const normalized = normalizeActionType(actionType);
  return normalized;
}

/**
 * Check if action type requires a draft
 */
function requiresDraft(actionType) {
  return DRAFT_REQUIRED_ACTIONS.includes(normalizeActionType(actionType));
}

/**
 * Check if action type always requires human gate
 */
function alwaysRequiresGate(actionType) {
  return ALWAYS_GATE_ACTIONS.includes(normalizeActionType(actionType));
}

/**
 * Check if action type can auto-execute
 */
function canAutoExecute(actionType) {
  return AUTO_EXECUTE_ACTIONS.includes(normalizeActionType(actionType));
}

/**
 * Get human-readable label for action type
 */
function getActionLabel(actionType) {
  try {
    const normalized = normalizeActionType(actionType);
    return ACTION_LABELS[normalized] || normalized;
  } catch {
    return actionType;
  }
}

module.exports = {
  // Constants
  SEND_INITIAL_REQUEST,
  SEND_FOLLOWUP,
  SEND_REBUTTAL,
  SEND_CLARIFICATION,
  RESPOND_PARTIAL_APPROVAL,
  ACCEPT_FEE,
  NEGOTIATE_FEE,
  DECLINE_FEE,
  ESCALATE,
  NONE,
  CLOSE_CASE,
  WITHDRAW,
  RESEARCH_AGENCY,
  REFORMULATE_REQUEST,
  SUBMIT_PORTAL,
  SEND_PDF_EMAIL,

  // Lists
  ACTION_TYPES,
  DRAFT_REQUIRED_ACTIONS,
  ALWAYS_GATE_ACTIONS,
  AUTO_EXECUTE_ACTIONS,
  ACTION_LABELS,
  LEGACY_ACTION_MAP,

  // Functions
  isValidActionType,
  normalizeActionType,
  validateActionType,
  requiresDraft,
  alwaysRequiresGate,
  canAutoExecute,
  getActionLabel
};
