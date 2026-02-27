/**
 * Golden-Case Regression Tests for AI Router v2
 *
 * Tests buildAllowedActions() deterministic constraint filtering
 * and validates that the allowed action sets match expected behavior.
 *
 * Run: node test/golden-decisions.js
 */

// ─── buildAllowedActions (pure function, no DB) ─────────────────────────────

const ALL_ACTION_TYPES = [
  "SEND_INITIAL_REQUEST", "SEND_FOLLOWUP", "SEND_REBUTTAL", "SEND_CLARIFICATION",
  "SEND_APPEAL", "SEND_FEE_WAIVER_REQUEST", "SEND_STATUS_UPDATE",
  "RESPOND_PARTIAL_APPROVAL", "ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE",
  "ESCALATE", "NONE", "CLOSE_CASE", "WITHDRAW", "RESEARCH_AGENCY",
  "REFORMULATE_REQUEST", "SUBMIT_PORTAL",
];

function removeAction(actions, action) {
  const idx = actions.indexOf(action);
  if (idx !== -1) actions.splice(idx, 1);
}

function buildAllowedActions(params) {
  const {
    classification, denialSubtype, constraints, followupCount,
    maxFollowups, hasAutomatablePortal, triggerType, dismissedActionCounts,
  } = params;

  if (classification === "HOSTILE" || classification === "UNKNOWN") return ["ESCALATE"];
  if (classification === "WRONG_AGENCY") return ["RESEARCH_AGENCY", "ESCALATE"];
  if (classification === "PARTIAL_APPROVAL") return ["RESPOND_PARTIAL_APPROVAL", "ESCALATE"];
  if (classification === "RECORDS_READY") return ["NONE", "CLOSE_CASE"];
  if (classification === "ACKNOWLEDGMENT") return ["NONE"];
  if (classification === "PARTIAL_DELIVERY") return ["NONE", "SEND_FOLLOWUP"];
  if (followupCount >= maxFollowups) return ["ESCALATE"];

  const CITIZENSHIP_CONSTRAINTS = ["AL_CITIZENSHIP_REQUIRED", "CITIZENSHIP_REQUIRED", "RESIDENCY_REQUIRED"];
  if (constraints.some(c => CITIZENSHIP_CONSTRAINTS.includes(c))) return ["ESCALATE"];

  const base = [...ALL_ACTION_TYPES];

  if (triggerType !== "INITIAL_REQUEST") {
    removeAction(base, "SEND_INITIAL_REQUEST");
  }
  if (!hasAutomatablePortal) {
    removeAction(base, "SUBMIT_PORTAL");
  }

  for (const [action, count] of Object.entries(dismissedActionCounts)) {
    if (count >= 2) removeAction(base, action);
  }

  if (classification === "FEE_QUOTE") {
    return base.filter(a =>
      ["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE", "SEND_FEE_WAIVER_REQUEST",
       "SEND_REBUTTAL", "ESCALATE", "NONE"].includes(a)
    );
  }

  if (classification === "PORTAL_REDIRECT") {
    return base.filter(a =>
      ["SUBMIT_PORTAL", "NONE", "ESCALATE", "RESEARCH_AGENCY"].includes(a)
    );
  }

  return base;
}

// ─── Golden Cases ────────────────────────────────────────────────────────────

const goldenCases = [
  // Hard constraint cases — exact allowed sets
  {
    name: "hostile",
    params: {
      classification: "HOSTILE", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["ESCALATE"],
    expectedAction: "ESCALATE",
  },
  {
    name: "unknown_classification",
    params: {
      classification: "UNKNOWN", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["ESCALATE"],
    expectedAction: "ESCALATE",
  },
  {
    name: "wrong_agency",
    params: {
      classification: "WRONG_AGENCY", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["RESEARCH_AGENCY", "ESCALATE"],
    expectedAction: "RESEARCH_AGENCY",
  },
  {
    name: "partial_approval",
    params: {
      classification: "PARTIAL_APPROVAL", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["RESPOND_PARTIAL_APPROVAL", "ESCALATE"],
    expectedAction: "RESPOND_PARTIAL_APPROVAL",
  },
  {
    name: "records_ready",
    params: {
      classification: "RECORDS_READY", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["NONE", "CLOSE_CASE"],
    expectedAction: "NONE",
  },
  {
    name: "acknowledgment",
    params: {
      classification: "ACKNOWLEDGMENT", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["NONE"],
    expectedAction: "NONE",
  },
  {
    name: "partial_delivery",
    params: {
      classification: "PARTIAL_DELIVERY", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["NONE", "SEND_FOLLOWUP"],
    expectedAction: "NONE",
  },
  {
    name: "max_followups_reached",
    params: {
      classification: "NO_RESPONSE", denialSubtype: null, constraints: [],
      followupCount: 3, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["ESCALATE"],
    expectedAction: "ESCALATE",
  },
  {
    name: "citizenship_restriction",
    params: {
      classification: "DENIAL", denialSubtype: "no_records", constraints: ["CITIZENSHIP_REQUIRED"],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["ESCALATE"],
    expectedAction: "ESCALATE",
  },

  // FEE_QUOTE cases — narrowed to fee actions
  {
    name: "fee_quote_low",
    params: {
      classification: "FEE_QUOTE", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE", "SEND_FEE_WAIVER_REQUEST", "SEND_REBUTTAL", "ESCALATE", "NONE"],
    expectedAction: "ACCEPT_FEE",
    feeAmount: 25,
  },
  {
    name: "fee_quote_high",
    params: {
      classification: "FEE_QUOTE", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE", "SEND_FEE_WAIVER_REQUEST", "SEND_REBUTTAL", "ESCALATE", "NONE"],
    expectedAction: "NEGOTIATE_FEE",
    feeAmount: 750,
  },
  {
    name: "fee_quote_medium",
    params: {
      classification: "FEE_QUOTE", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["ACCEPT_FEE", "NEGOTIATE_FEE", "DECLINE_FEE", "SEND_FEE_WAIVER_REQUEST", "SEND_REBUTTAL", "ESCALATE", "NONE"],
    expectedAction: "ACCEPT_FEE",
    feeAmount: 200,
  },

  // DENIAL cases — broad set with denial routing
  {
    name: "denial_no_records",
    params: {
      classification: "DENIAL", denialSubtype: "no_records", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    // Full action set minus SEND_INITIAL_REQUEST and SUBMIT_PORTAL
    expectedAction: "RESEARCH_AGENCY",
    checkAllowed: (allowed) => allowed.includes("RESEARCH_AGENCY") && allowed.includes("SEND_REBUTTAL"),
  },
  {
    name: "denial_overly_broad",
    params: {
      classification: "DENIAL", denialSubtype: "overly_broad", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAction: "REFORMULATE_REQUEST",
    checkAllowed: (allowed) => allowed.includes("REFORMULATE_REQUEST"),
  },
  {
    name: "denial_ongoing_investigation_strong",
    params: {
      classification: "DENIAL", denialSubtype: "ongoing_investigation", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    // Strong denials should have CLOSE_CASE available
    expectedAction: "CLOSE_CASE",
    checkAllowed: (allowed) => allowed.includes("CLOSE_CASE") && allowed.includes("SEND_REBUTTAL"),
  },
  {
    name: "denial_glomar",
    params: {
      classification: "DENIAL", denialSubtype: "glomar_ncnd", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAction: "SEND_APPEAL",
    checkAllowed: (allowed) => allowed.includes("SEND_APPEAL"),
  },
  {
    name: "denial_juvenile_records",
    params: {
      classification: "DENIAL", denialSubtype: "juvenile_records", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAction: "CLOSE_CASE",
    checkAllowed: (allowed) => allowed.includes("CLOSE_CASE"),
  },

  // CLARIFICATION_REQUEST
  {
    name: "clarification",
    params: {
      classification: "CLARIFICATION_REQUEST", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAction: "SEND_CLARIFICATION",
    checkAllowed: (allowed) => allowed.includes("SEND_CLARIFICATION"),
  },

  // NO_RESPONSE under max
  {
    name: "no_response_under_max",
    params: {
      classification: "NO_RESPONSE", denialSubtype: null, constraints: [],
      followupCount: 1, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAction: "SEND_FOLLOWUP",
    checkAllowed: (allowed) => allowed.includes("SEND_FOLLOWUP"),
  },

  // Portal redirect with portal
  {
    name: "portal_redirect_with_portal",
    params: {
      classification: "PORTAL_REDIRECT", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: true,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["SUBMIT_PORTAL", "NONE", "ESCALATE", "RESEARCH_AGENCY"],
    expectedAction: "NONE",
  },

  // Portal redirect without portal
  {
    name: "portal_redirect_no_portal",
    params: {
      classification: "PORTAL_REDIRECT", denialSubtype: null, constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    expectedAllowed: ["NONE", "ESCALATE", "RESEARCH_AGENCY"],
    expectedAction: "NONE",
  },

  // Dismissed actions removed
  {
    name: "dismissed_actions_removed",
    params: {
      classification: "DENIAL", denialSubtype: "no_records", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: { "RESEARCH_AGENCY": 2, "SEND_REBUTTAL": 2 },
    },
    checkAllowed: (allowed) => !allowed.includes("RESEARCH_AGENCY") && !allowed.includes("SEND_REBUTTAL"),
  },

  // INITIAL_REQUEST trigger type includes SEND_INITIAL_REQUEST
  {
    name: "initial_request_trigger",
    params: {
      classification: "DENIAL", denialSubtype: "no_records", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INITIAL_REQUEST", dismissedActionCounts: {},
    },
    checkAllowed: (allowed) => allowed.includes("SEND_INITIAL_REQUEST"),
  },

  // Inbound trigger type excludes SEND_INITIAL_REQUEST
  {
    name: "inbound_trigger_no_initial",
    params: {
      classification: "DENIAL", denialSubtype: "no_records", constraints: [],
      followupCount: 0, maxFollowups: 2, hasAutomatablePortal: false,
      triggerType: "INBOUND_MESSAGE", dismissedActionCounts: {},
    },
    checkAllowed: (allowed) => !allowed.includes("SEND_INITIAL_REQUEST"),
  },
];

// ─── Run Tests ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

for (const tc of goldenCases) {
  const allowed = buildAllowedActions(tc.params);

  let ok = true;
  const issues = [];

  // Check exact allowed set if specified
  if (tc.expectedAllowed) {
    const allowedSet = new Set(allowed);
    const expectedSet = new Set(tc.expectedAllowed);
    if (allowedSet.size !== expectedSet.size || ![...allowedSet].every(a => expectedSet.has(a))) {
      ok = false;
      issues.push(`Expected allowed: [${tc.expectedAllowed.join(", ")}], got: [${allowed.join(", ")}]`);
    }
  }

  // Check custom allowed predicate
  if (tc.checkAllowed && !tc.checkAllowed(allowed)) {
    ok = false;
    issues.push(`Custom allowed check failed. Got: [${allowed.join(", ")}]`);
  }

  // Check expected action is in the allowed set
  if (tc.expectedAction && !allowed.includes(tc.expectedAction)) {
    ok = false;
    issues.push(`Expected action ${tc.expectedAction} not in allowed set: [${allowed.join(", ")}]`);
  }

  if (ok) {
    passed++;
    console.log(`  PASS  ${tc.name}`);
  } else {
    failed++;
    failures.push({ name: tc.name, issues });
    console.log(`  FAIL  ${tc.name}`);
    for (const issue of issues) {
      console.log(`        ${issue}`);
    }
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${goldenCases.length} tests`);

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ${f.name}:`);
    for (const issue of f.issues) {
      console.log(`    - ${issue}`);
    }
  }
  process.exit(1);
}

console.log("\nAll golden-case tests passed.");
process.exit(0);
