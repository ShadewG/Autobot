/**
 * Autobot Decision Quality Test Runner
 *
 * Runs all test cases through the simulate-decision task, compares to expected
 * actions, and saves failures as eval cases for tracking.
 *
 * Usage: TRIGGER_SECRET_KEY=tr_prod_... node scripts/_run_sim_tests.js
 */

require('dotenv').config();
const { tasks, runs } = require('@trigger.dev/sdk');
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 4;       // concurrent simulations at once
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

// ── Test Cases ─────────────────────────────────────────────────────────────────
// Format: { id, label, fromEmail, subject, body, expectedClassification, expectedAction, risk }
// risk: 'high' | 'medium' | 'low'

const TEST_CASES = [
  // ── CATEGORY A: Fee Routing ──────────────────────────────────────────────────
  {
    id: 'TC-01', label: 'Small fee — auto-execute',
    fromEmail: 'records@somecity.gov',
    subject: 'RE: Public Records Request - Processing Fee',
    body: 'Processing your request will cost $45.00. Please remit payment to proceed.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'medium',
  },
  {
    id: 'TC-02', label: 'Fee at exact $100 auto-approve limit',
    fromEmail: 'records@agency.gov',
    subject: 'Fee Notice',
    body: 'Your processing fee is $100.00 exactly. Please remit to proceed.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'high',
  },
  {
    id: 'TC-03', label: 'Fee $250 — human review required',
    fromEmail: 'records@city.gov',
    subject: 'RE: Request - Fee Required',
    body: 'We require a $250 deposit before processing can begin.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'medium',
  },
  {
    id: 'TC-04', label: 'Fee at $500 — should NOT trigger NEGOTIATE',
    fromEmail: 'foia@dept.gov',
    subject: 'Fee Estimate',
    body: 'The estimated cost for processing is $500.00.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'high',
  },
  {
    id: 'TC-05', label: 'Fee $501 — triggers NEGOTIATE_FEE',
    fromEmail: 'records@county.gov',
    subject: 'Records Request - Fee',
    body: 'Producing these records will cost $501. Payment required upfront.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'NEGOTIATE_FEE',
    risk: 'high',
  },
  {
    id: 'TC-06', label: 'Very large fee $3,500',
    fromEmail: 'records@bigagency.gov',
    subject: 'Fee Estimate for Records Request',
    body: 'The total estimated cost is $3,500 for 2,000 pages at $1.75/page.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'NEGOTIATE_FEE',
    risk: 'low',
  },
  {
    id: 'TC-07', label: 'Fee + BWC denial in same message — rebuttal should win',
    fromEmail: 'records@pd.gov',
    subject: 'Response to Records Request',
    body: 'The processing fee is $75. Note: body camera footage is exempt from disclosure under our records policy and will not be provided.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'high',
  },
  {
    id: 'TC-08', label: 'Fee amount missing — just a warning about fees',
    fromEmail: 'foia@agency.gov',
    subject: 'Records Request - Potential Fees',
    body: 'Before we can process your request, please confirm whether you wish to proceed if fees apply. We will send a formal estimate once we assess the scope.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'NEGOTIATE_FEE',
    risk: 'medium',
  },
  {
    id: 'TC-09', label: 'Dollar amount in record content — NOT a fee',
    fromEmail: 'records@court.gov',
    subject: 'Response to Your Records Request',
    body: 'Please find attached the officer\'s incident report. The incident involved property damage valued at $1,200 to the vehicle.',
    expectedClassification: 'RECORDS_READY',
    expectedAction: 'NONE',
    risk: 'high',
  },

  // ── CATEGORY B: Denial Subtypes ───────────────────────────────────────────────
  {
    id: 'TC-11', label: 'No records denial',
    fromEmail: 'records@pd.gov',
    subject: 'RE: FOIA Request - No Responsive Records',
    body: 'We have conducted a thorough search and found no records responsive to your request.',
    expectedClassification: 'DENIAL',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },
  {
    id: 'TC-12', label: 'Overly broad denial',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Public Records Request - Overly Broad',
    body: 'Your request encompasses an estimated 50,000 pages over 10 years and is overly burdensome. Please narrow your request to a specific date range or incident.',
    expectedClassification: 'DENIAL',
    expectedAction: 'REFORMULATE_REQUEST',
    risk: 'medium',
  },
  {
    id: 'TC-13', label: 'Ongoing investigation — weak denial',
    fromEmail: 'foia@agency.gov',
    subject: 'RE: Records Request',
    body: 'This matter is under internal review at this time.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'high',
  },
  {
    id: 'TC-14', label: 'Ongoing investigation — strong denial (2+ indicators)',
    fromEmail: 'foia@feds.gov',
    subject: 'RE: FOIA Request - Exemption 7(A)',
    body: 'These records are exempt under Exemption 7(A) as the subject is under active federal prosecution. Releasing them would interfere with ongoing litigation and violate requirements of the pending court case.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },
  {
    id: 'TC-15', label: 'Privacy exemption — weak',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request',
    body: 'Some information may be withheld to protect individual privacy.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'high',
  },
  {
    id: 'TC-16', label: 'Privacy exemption — strong (2+ indicators)',
    fromEmail: 'foia@agency.gov',
    subject: 'RE: Records Request - Privacy Exemption',
    body: 'These records are exempt from disclosure under the privacy statute. The confidential nature of this information and the privacy of the individuals involved prevents any release.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },
  {
    id: 'TC-17', label: 'Excessive fees denial',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Excessive Fee',
    body: 'Fulfilling this request would require 200 hours of staff time at $75/hour for a total of $15,000, making it cost-prohibitive to process.',
    expectedClassification: 'DENIAL',
    expectedAction: 'NEGOTIATE_FEE',
    risk: 'medium',
  },
  {
    id: 'TC-18', label: 'Retention expired — records destroyed',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request - Records Destroyed',
    body: 'Per our records retention schedule, documents from that period were destroyed in 2019. We have no obligation to retain records beyond the statutory retention period.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'medium',
  },
  {
    id: 'TC-19', label: 'Glomar — neither confirm nor deny',
    fromEmail: 'foia@federal.gov',
    subject: 'RE: FOIA Request - Glomar Response',
    body: 'We can neither confirm nor deny the existence of any records related to your request, as doing so would itself reveal classified information.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_APPEAL',
    risk: 'high',
  },
  {
    id: 'TC-20', label: 'Not reasonably described',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Clarification Needed',
    body: 'Your request for "any records related to any officer" does not reasonably describe the records sought. Please provide specific names, dates, or incident numbers.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_CLARIFICATION',
    risk: 'medium',
  },
  {
    id: 'TC-21', label: 'No duty to create new records',
    fromEmail: 'foia@dept.gov',
    subject: 'RE: Records Request - No Obligation',
    body: 'We do not maintain a centralized database of the type you describe. Fulfilling this request would require creating new records, which we have no obligation to do.',
    expectedClassification: 'DENIAL',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },
  {
    id: 'TC-22', label: 'Attorney-client privilege / work product',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Privileged',
    body: 'The responsive records are attorney work product protected by the attorney-client privilege and are therefore exempt from disclosure under applicable exemptions.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_APPEAL',
    risk: 'high',
  },
  {
    id: 'TC-23', label: 'Juvenile records — sealed',
    fromEmail: 'records@court.gov',
    subject: 'RE: Records Request - Juvenile Records',
    body: 'Your request concerns records of a minor, which are sealed under the state juvenile code. We cannot disclose these records under any circumstances.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'medium',
  },
  {
    id: 'TC-24', label: 'Sealed by court order',
    fromEmail: 'records@clerk.gov',
    subject: 'RE: Records Request - Sealed',
    body: 'The records you requested are sealed by court order in Case No. 2023-CR-1145. We are prohibited from releasing them.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'medium',
  },
  {
    id: 'TC-25', label: 'Third-party confidential',
    fromEmail: 'foia@agency.gov',
    subject: 'RE: Records Request - Confidential',
    body: 'The requested records contain confidential business information submitted by third parties under an expectation of confidentiality.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'medium',
  },
  {
    id: 'TC-26', label: 'Records not yet created',
    fromEmail: 'records@dept.gov',
    subject: 'RE: Records Request - Not Yet Available',
    body: 'The report you are requesting is currently being compiled. It will not be available until Q4 of this year.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_STATUS_UPDATE',
    risk: 'medium',
  },
  {
    id: 'TC-27', label: 'Wrong agency as denial subtype',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request - Wrong Agency',
    body: 'Records of this type are maintained by the County Clerk, not our office. Please contact them directly at countyrecords@county.gov.',
    expectedClassification: 'DENIAL',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },

  // ── CATEGORY C: Acknowledgment, Records Ready, Partial ────────────────────────
  {
    id: 'TC-31', label: 'Basic acknowledgment',
    fromEmail: 'records@dept.gov',
    subject: 'Acknowledgment of Public Records Request',
    body: 'Thank you for your records request. We have assigned it reference number 2024-1234 and will respond within 10 business days as required by law.',
    expectedClassification: 'ACKNOWLEDGMENT',
    expectedAction: 'NONE',
    risk: 'low',
  },
  {
    id: 'TC-32', label: 'Records ready — full delivery',
    fromEmail: 'records@agency.gov',
    subject: 'Response to Your Records Request - Records Attached',
    body: 'Please find attached the complete records you requested. This fulfills your request in its entirety. Please let us know if you need anything further.',
    expectedClassification: 'RECORDS_READY',
    expectedAction: 'NONE',
    risk: 'low',
  },
  {
    id: 'TC-33', label: 'Partial delivery — more to follow',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request - Partial Response',
    body: 'We are providing 50 pages of responsive records today. Additional records are being processed and will be delivered within 30 days.',
    expectedClassification: 'PARTIAL_DELIVERY',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TC-34', label: 'Partial approval — some released, BWC withheld',
    fromEmail: 'records@pd.gov',
    subject: 'RE: Records Request - Partial Response',
    body: 'We are releasing the incident report and dispatch logs. However, the officer\'s body camera footage is withheld under our use-of-force policy as the investigation is ongoing.',
    expectedClassification: 'PARTIAL_APPROVAL',
    expectedAction: 'RESPOND_PARTIAL_APPROVAL',
    risk: 'medium',
  },
  {
    id: 'TC-35', label: 'Records available at portal link (pickup, NOT redirect)',
    fromEmail: 'noreply@govqa.us',
    subject: 'Records Available for Download',
    body: 'Your requested records are now available for download. Please log in to the portal to retrieve your files: https://portal.govqa.us/download/xyz123. This link expires in 30 days.',
    expectedClassification: 'RECORDS_READY',
    expectedAction: 'NONE',
    risk: 'high',
  },

  // ── CATEGORY D: Clarification, Portal Redirect, Wrong Agency ─────────────────
  {
    id: 'TC-37', label: 'Identifier clarification request',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Need More Information',
    body: 'Please provide the full name of the individual involved and the approximate date of the incident so we can conduct an accurate search.',
    expectedClassification: 'CLARIFICATION_REQUEST',
    expectedAction: 'SEND_CLARIFICATION',
    risk: 'low',
  },
  {
    id: 'TC-38', label: 'Scope narrowing — could be clarification or overly broad denial',
    fromEmail: 'foia@dept.gov',
    subject: 'RE: Records Request - Scope Too Broad',
    body: 'Your request encompasses 15 years of records. Please narrow the date range to no more than 3 years for us to be able to process it.',
    expectedClassification: 'CLARIFICATION_REQUEST',
    expectedAction: 'SEND_CLARIFICATION',
    risk: 'high',
  },
  {
    id: 'TC-39', label: 'Portal redirect with URL',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request - Portal Required',
    body: 'All public records requests must be submitted through our online portal. Please visit https://cityrecords.govqa.us to submit your request.',
    expectedClassification: 'PORTAL_REDIRECT',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TC-40', label: 'Portal redirect without URL',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request',
    body: 'Please submit your request through our online records management system. Contact our office for the portal link.',
    expectedClassification: 'PORTAL_REDIRECT',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TC-41', label: 'Wrong agency — direct classification',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Wrong Agency',
    body: 'We are not the custodian of the records you seek. Please contact the State Police Records Division at statepolice.gov.',
    expectedClassification: 'WRONG_AGENCY',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },
  {
    id: 'TC-42', label: 'Wrong agency with referral contact info',
    fromEmail: 'records@pd.gov',
    subject: 'RE: Records Request - Referral',
    body: 'We don\'t have those records. Please contact the County Sheriff at records@sheriff.county.gov or call (555) 555-1234.',
    expectedClassification: 'WRONG_AGENCY',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },

  // ── CATEGORY E: Hostile, Unknown, Escalation ─────────────────────────────────
  {
    id: 'TC-43', label: 'Hostile response',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Your Continued Requests',
    body: 'Stop filing frivolous requests or we will refer you for criminal harassment charges. This is your final warning.',
    expectedClassification: 'HOSTILE',
    expectedAction: 'ESCALATE',
    risk: 'low',
  },
  {
    id: 'TC-44', label: 'Vague / ambiguous response — should escalate',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request',
    body: 'We are reviewing your correspondence and will be in touch. Please allow additional time for our review.',
    expectedClassification: 'ACKNOWLEDGMENT',
    expectedAction: 'NONE',
    risk: 'medium',
  },

  // ── CATEGORY F: Edge Cases ────────────────────────────────────────────────────
  {
    id: 'TC-48', label: 'Dollar amount in records — not a fee (settlement)',
    fromEmail: 'records@court.gov',
    subject: 'Response: Settlement Records',
    body: 'Enclosed are the settlement records you requested showing the $350 payment to the plaintiff. The processing fee is waived as this is a public interest request.',
    expectedClassification: 'RECORDS_READY',
    expectedAction: 'NONE',
    risk: 'high',
  },
  {
    id: 'TC-49', label: 'Ambiguous partial — withheld by privilege alongside delivery',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Partial Response',
    body: 'We are releasing the incident log and dispatch records. However, communications between officers and legal counsel are withheld under attorney-client privilege.',
    expectedClassification: 'PARTIAL_APPROVAL',
    expectedAction: 'RESPOND_PARTIAL_APPROVAL',
    risk: 'high',
  },
  {
    id: 'TC-50', label: 'Portal confirmation email — should be ACK not PORTAL_REDIRECT',
    fromEmail: 'noreply@nextrequest.com',
    subject: 'Submission Confirmation - Your Request Has Been Received',
    body: 'Your public records request has been submitted successfully. Reference number: 2024-5678. The agency will respond within the required timeframe.',
    expectedClassification: 'ACKNOWLEDGMENT',
    expectedAction: 'NONE',
    risk: 'high',
  },
  {
    id: 'TC-51', label: 'Fee $0.50 — below $1 sanity threshold',
    fromEmail: 'records@library.gov',
    subject: 'Records Request - Minimal Fee',
    body: 'Your request is ready. There is a minimal processing fee of $0.50 for the copies. Please remit payment.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'medium',
  },
  {
    id: 'TC-52', label: 'Multi-paragraph denial — strong indicators buried in text',
    fromEmail: 'foia@federal.gov',
    subject: 'RE: FOIA Request - Denial',
    body: `Thank you for your FOIA request. We have conducted a thorough search of our records. After careful review, we must deny your request. The records you seek are part of an active, ongoing federal investigation. Disclosure at this time would seriously interfere with enforcement proceedings, jeopardize the safety of witnesses, and compromise law enforcement techniques currently in use. The exemption under 5 U.S.C. 552(b)(7)(A) applies in full. We are prohibited from disclosing any records related to this active prosecution.`,
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },
  {
    id: 'TC-53', label: 'Denial with offer to clarify — should not just close',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request',
    body: 'We searched our records and found nothing responsive. However, if you can provide a specific incident number or officer name, we can conduct a more targeted search.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_CLARIFICATION',
    risk: 'high',
  },
  {
    id: 'TC-54', label: 'Fee + partial release in same message',
    fromEmail: 'records@dept.gov',
    subject: 'RE: Records Request - Partial Response and Fee',
    body: 'We are releasing the incident report at no charge. However, 500 pages of email communications will require a processing fee of $150 to produce. Please advise if you wish to proceed with the email records.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'high',
  },
  {
    id: 'TC-55', label: 'Very short denial — minimal text',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request',
    body: 'Request denied.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'medium',
  },
  {
    id: 'TC-56', label: 'Extension of time notice',
    fromEmail: 'foia@agency.gov',
    subject: 'RE: FOIA Request - Extension of Time',
    body: 'We are writing to notify you that we require an additional 20 business days to respond to your request due to unusual circumstances. We will provide a response no later than 30 days from today.',
    expectedClassification: 'ACKNOWLEDGMENT',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TC-57', label: 'Records ready email with no attachment',
    fromEmail: 'records@dept.gov',
    subject: 'RE: Records Request - Response Attached',
    body: 'Please see attached our response to your public records request.',
    expectedClassification: 'RECORDS_READY',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TC-58', label: 'Denial citing no duty to create + overly broad combined',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Denial',
    body: 'Your request is overly broad and would require us to create new records by compiling data that does not exist in the form requested. We have no obligation to create new records.',
    expectedClassification: 'DENIAL',
    expectedAction: 'REFORMULATE_REQUEST',
    risk: 'high',
  },
  {
    id: 'TC-59', label: 'Clarification required — identity verification',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Identity Verification',
    body: 'To process your request for personal records, we require proof of identity. Please submit a government-issued photo ID before we can proceed.',
    expectedClassification: 'CLARIFICATION_REQUEST',
    expectedAction: 'SEND_CLARIFICATION',
    risk: 'low',
  },
  {
    id: 'TC-60', label: 'Denial — vague "policy" reason (unknown subtype)',
    fromEmail: 'records@corp.gov',
    subject: 'RE: Records Request',
    body: 'We are unable to fulfill your request due to internal policy restrictions.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'high',
  },
  {
    id: 'TC-61', label: 'Denial — statutory exemption cited but weak language',
    fromEmail: 'foia@state.gov',
    subject: 'RE: Records Request - Exemption Applied',
    body: 'Pursuant to Government Code Section 6254, we are withholding these records as they are exempt from disclosure.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'high',
  },
  {
    id: 'TC-62', label: 'Delivery with redactions noted',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request - Redacted Response',
    body: 'Attached are the responsive records. Certain personal identifying information has been redacted pursuant to privacy exemptions. The remaining information is provided in full.',
    expectedClassification: 'PARTIAL_APPROVAL',
    expectedAction: 'RESPOND_PARTIAL_APPROVAL',
    risk: 'medium',
  },
];

// ── Utilities ──────────────────────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function log(msg) { process.stdout.write(msg + '\n'); }
function ok(msg) { log(`  ${COLORS.green}✓${COLORS.reset} ${msg}`); }
function fail(msg) { log(`  ${COLORS.red}✗${COLORS.reset} ${msg}`); }
function info(msg) { log(`  ${COLORS.cyan}→${COLORS.reset} ${msg}`); }
function warn(msg) { log(`  ${COLORS.yellow}!${COLORS.reset} ${msg}`); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pollRun(runId, label) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await runs.retrieve(runId);
    if (run.status === 'COMPLETED') return { ok: true, output: run.output };
    if (['FAILED', 'CRASHED', 'CANCELED'].includes(run.status)) {
      return { ok: false, error: run.output?.message || run.status };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, error: 'timeout' };
}

async function runTestCase(tc) {
  try {
    const handle = await tasks.trigger('simulate-decision', {
      messageBody: tc.body,
      fromEmail: tc.fromEmail,
      subject: tc.subject,
    });
    const result = await pollRun(handle.id, tc.label);
    if (!result.ok) return { tc, status: 'error', error: result.error };

    const simResult = result.output;
    const actualAction = simResult?.decision?.action;
    const actualClass = simResult?.classification?.messageType;
    const pass = actualAction === tc.expectedAction;

    return {
      tc,
      status: pass ? 'pass' : 'fail',
      actualAction,
      actualClass,
      reasoning: simResult?.decision?.reasoning || [],
      simResult,
    };
  } catch (err) {
    return { tc, status: 'error', error: err.message };
  }
}

async function saveFailuresAsEval(failures, pool) {
  if (failures.length === 0) return;
  info(`Saving ${failures.length} failures as eval cases...`);
  for (const f of failures) {
    try {
      await pool.query(
        `INSERT INTO eval_cases
           (expected_action, notes,
            simulated_message_body, simulated_from_email, simulated_subject,
            simulated_predicted_action, simulated_reasoning, simulated_draft_body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          f.tc.expectedAction,
          `[AUTO] ${f.tc.label} — AI chose ${f.actualAction}, expected ${f.tc.expectedAction}. Risk: ${f.tc.risk}`,
          f.tc.body.substring(0, 10000),
          f.tc.fromEmail,
          f.tc.subject,
          f.actualAction || 'UNKNOWN',
          JSON.stringify(f.reasoning || []),
          f.simResult?.draftReply?.body?.substring(0, 5000) || null,
        ]
      );
      ok(`Saved eval case: ${f.tc.id} — ${f.tc.label}`);
    } catch (err) {
      warn(`Failed to save eval case ${f.tc.id}: ${err.message}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const key = process.env.TRIGGER_SECRET_KEY;
  if (!key) {
    log(`${COLORS.red}Error: TRIGGER_SECRET_KEY not set${COLORS.reset}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DB_URL });

  log('');
  log(`${COLORS.bold}Autobot Decision Quality Test Runner${COLORS.reset}`);
  log(`${COLORS.dim}${TEST_CASES.length} test cases, batch size ${BATCH_SIZE}${COLORS.reset}`);
  log('');

  const allResults = [];
  const batches = [];
  for (let i = 0; i < TEST_CASES.length; i += BATCH_SIZE) {
    batches.push(TEST_CASES.slice(i, i + BATCH_SIZE));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    log(`${COLORS.dim}── Batch ${bi + 1}/${batches.length} (${batch.map(t => t.id).join(', ')}) ──${COLORS.reset}`);
    const results = await Promise.all(batch.map(tc => runTestCase(tc)));
    for (const r of results) {
      if (r.status === 'pass') {
        ok(`${r.tc.id} ${r.tc.label} → ${COLORS.green}${r.actualAction}${COLORS.reset} ✓`);
      } else if (r.status === 'fail') {
        fail(`${r.tc.id} ${r.tc.label}`);
        log(`       Expected: ${COLORS.green}${r.tc.expectedAction}${COLORS.reset}`);
        log(`       Got:      ${COLORS.red}${r.actualAction}${COLORS.reset}  (classified as: ${r.actualClass})`);
        if (r.reasoning.length) {
          log(`       Reasoning: ${COLORS.dim}${r.reasoning.slice(0, 2).join(' | ')}${COLORS.reset}`);
        }
      } else {
        warn(`${r.tc.id} ${r.tc.label} — ERROR: ${r.error}`);
      }
    }
    allResults.push(...results);
    log('');
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const passes = allResults.filter(r => r.status === 'pass');
  const failures = allResults.filter(r => r.status === 'fail');
  const errors = allResults.filter(r => r.status === 'error');

  log(`${COLORS.bold}── Results ──────────────────────────────────────${COLORS.reset}`);
  log(`  Total:   ${TEST_CASES.length}`);
  log(`  ${COLORS.green}Passed:  ${passes.length}${COLORS.reset}`);
  log(`  ${COLORS.red}Failed:  ${failures.length}${COLORS.reset}`);
  if (errors.length) log(`  ${COLORS.yellow}Errors:  ${errors.length}${COLORS.reset}`);
  log('');

  if (failures.length) {
    log(`${COLORS.bold}── Failures by Risk ─────────────────────────────${COLORS.reset}`);
    const byRisk = { high: [], medium: [], low: [] };
    for (const f of failures) (byRisk[f.tc.risk] || byRisk.low).push(f);
    for (const risk of ['high', 'medium', 'low']) {
      if (byRisk[risk].length === 0) continue;
      log(`\n  ${risk.toUpperCase()} risk:`);
      for (const f of byRisk[risk]) {
        log(`    ${f.tc.id}: ${f.tc.label}`);
        log(`      Expected ${f.tc.expectedAction} → got ${f.actualAction} (${f.actualClass})`);
      }
    }
    log('');

    // ── Action mismatch analysis ──
    log(`${COLORS.bold}── Action Mismatch Patterns ─────────────────────${COLORS.reset}`);
    const mismatchMap = {};
    for (const f of failures) {
      const key = `${f.tc.expectedAction} → ${f.actualAction}`;
      mismatchMap[key] = (mismatchMap[key] || 0) + 1;
    }
    const sorted = Object.entries(mismatchMap).sort((a, b) => b[1] - a[1]);
    for (const [pattern, count] of sorted) {
      log(`  ${count}x  ${pattern}`);
    }
    log('');

    await saveFailuresAsEval(failures, pool);
    log('');
    log(`${COLORS.yellow}${failures.length} failures saved to eval cases. Visit /eval to run LLM scoring.${COLORS.reset}`);
  } else {
    log(`${COLORS.green}All tests passed!${COLORS.reset}`);
  }

  log('');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
