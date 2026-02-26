/**
 * Autobot Advanced Decision Quality Test Runner
 *
 * 30 harder test cases: multi-signal messages, edge-case fee parsing,
 * denial-strength gradients, ambiguous classifications, formal bureaucratic language.
 *
 * Usage: TRIGGER_SECRET_KEY=tr_prod_... node scripts/_run_advanced_sim_tests.js
 */

require('dotenv').config();
const { tasks, runs } = require('@trigger.dev/sdk/v3');
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 6;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

// ── Advanced Test Cases ────────────────────────────────────────────────────────
const TEST_CASES = [

  // ── Fee edge cases ────────────────────────────────────────────────────────

  {
    id: 'TA-01',
    label: 'Fee waiver denied — new fee quoted ($175)',
    fromEmail: 'records@city.gov',
    subject: 'RE: FOIA Request — Fee Waiver Denial',
    body: 'After review, your request for a fee waiver has been denied as you do not qualify under our indigency or public-interest criteria. The estimated cost of production is $175. Please remit payment by check or money order before we proceed.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'medium',
  },
  {
    id: 'TA-02',
    label: 'Fee authorization request — up to $500',
    fromEmail: 'foia@agency.gov',
    subject: 'RE: FOIA Request — Fee Authorization Required',
    body: 'Before we begin processing your request, we require written authorization to incur fees up to $500. If anticipated costs will exceed this amount, we will contact you with an updated estimate before proceeding. Please confirm your authorization in writing.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'medium',
  },
  {
    id: 'TA-03',
    label: 'Fee warning — no amount yet, will send estimate',
    fromEmail: 'records@dept.gov',
    subject: 'RE: Records Request — Fees Anticipated',
    body: 'We have completed our initial search and located responsive records. There will be fees associated with processing, duplication, and staff review time. We will send a formal fee estimate within 10 business days. If you wish to request a fee waiver, please submit that request in writing at that time.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'NEGOTIATE_FEE',
    risk: 'medium',
  },
  {
    id: 'TA-04',
    label: 'Large fee — $89.50 (just under auto-approve threshold)',
    fromEmail: 'foia@federal.gov',
    subject: 'RE: FOIA Request — Fee Estimate',
    body: 'Pursuant to our FOIA fee schedule, the estimated cost to process your request is $89.50, covering 3.5 hours of search time at $16/hour and 525 pages of duplication at $0.10/page. Please remit this amount to the Treasury Department before we release the records.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'medium',
  },

  // ── Partial approval / partial release ──────────────────────────────────

  {
    id: 'TA-05',
    label: 'Partial release with attorney-client redactions',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request — Partial Response',
    body: 'Please find attached 127 pages of responsive records. Pages 34-67 have been redacted in full pursuant to the attorney-client privilege and work product doctrine. The remaining 60 pages are being released in their entirety.',
    expectedClassification: 'PARTIAL_APPROVAL',
    expectedAction: 'RESPOND_PARTIAL_APPROVAL',
    risk: 'medium',
  },
  {
    id: 'TA-06',
    label: 'Partial release + more records withheld under investigation',
    fromEmail: 'foia@federal.gov',
    subject: 'RE: FOIA Request — Interim Response',
    body: 'We are releasing 50 pages of non-exempt responsive records (attached). An additional 200 pages are being withheld in full under Exemption 7(A) as they are part of an active law enforcement investigation. We will reassess the withheld documents when the investigation concludes.',
    expectedClassification: 'PARTIAL_APPROVAL',
    expectedAction: 'RESPOND_PARTIAL_APPROVAL',
    risk: 'medium',
  },
  {
    id: 'TA-07',
    label: 'Rolling production — first batch ready, more to follow',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request — Interim Production',
    body: 'We are pleased to provide the first installment of responsive records (45 pages, attached). The remaining 300 pages are still being processed and will be provided on a rolling basis, with subsequent batches provided every two weeks. We anticipate full production to be complete within 60 days.',
    expectedClassification: 'PARTIAL_DELIVERY',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TA-08',
    label: 'Records available at expiring portal link',
    fromEmail: 'noreply@govportal.gov',
    subject: 'Your Records Request — Download Available',
    body: 'Your public records are ready for download. Please log in to our secure portal at https://records.city.gov/download and enter your claim code: PRA-2024-00789. Your records (234 pages) will be available for 30 days from today.',
    expectedClassification: 'RECORDS_READY',
    expectedAction: 'NONE',
    risk: 'medium',
  },

  // ── Strong denials → CLOSE_CASE ─────────────────────────────────────────

  {
    id: 'TA-09',
    label: 'Denial — court protective order (explicit)',
    fromEmail: 'foia@court.gov',
    subject: 'RE: FOIA Request — Court Order Applies',
    body: 'The documents you requested are subject to a court-issued protective order entered in Case No. 2023-CV-4521 (N.D. Cal.), which prohibits disclosure of these materials. We are legally prohibited from producing any records covered by this order. No responsive records will be produced at this time.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },
  {
    id: 'TA-10',
    label: 'Denial — privacy + law enforcement (dual strong exemption)',
    fromEmail: 'foia@federal.gov',
    subject: 'RE: FOIA Request — Full Denial',
    body: 'After thorough review, your request is denied in full. All responsive records are protected under two exemptions: Exemption 6 (personal privacy — the records contain personal identifying information of private individuals) and Exemption 7(C) (law enforcement privacy — the records are part of law enforcement files and disclosure would constitute an unwarranted invasion of personal privacy). These exemptions are mandatory and no segregable non-exempt portions exist.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },
  {
    id: 'TA-11',
    label: 'Denial — ongoing investigation, explicitly prohibiting disclosure',
    fromEmail: 'foia@doj.gov',
    subject: 'RE: FOIA Request — Active Investigation',
    body: 'The records you have requested relate to an open and active federal criminal investigation. Disclosure of these records at this time could seriously interfere with ongoing enforcement proceedings, jeopardize the safety of confidential informants, and compromise active law enforcement techniques. The records are withheld in full under 5 U.S.C. 552(b)(7)(A) and cannot be provided.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },
  {
    id: 'TA-12',
    label: 'Denial — juvenile records (absolute protection)',
    fromEmail: 'records@court.gov',
    subject: 'RE: Records Request — Juvenile Matter',
    body: 'The records you have requested relate to a juvenile proceeding. All records pertaining to juvenile matters are sealed by statute and are absolutely confidential. We are legally prohibited from releasing any information from these files regardless of the nature of the request or the identity of the requester.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },

  // ── Weak denials → SEND_REBUTTAL ────────────────────────────────────────

  {
    id: 'TA-13',
    label: 'Records destroyed — possible retention challenge',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request — Records Destroyed',
    body: 'After a diligent search, we have determined that the records responsive to your request were destroyed in 2020 pursuant to our records retention schedule (Schedule Code G-4, Series 12). The applicable retention period for this record type is 5 years from the date of creation.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'medium',
  },
  {
    id: 'TA-14',
    label: 'Informal denial — no records, suggests county office',
    fromEmail: 'clerk@smallcity.gov',
    subject: 'Re: your records request',
    body: 'Hi, I looked into your request and we honestly don\'t seem to have anything that matches what you\'re describing. We\'re a small department and I don\'t think we keep that kind of documentation. You might want to try the county office.',
    expectedClassification: 'DENIAL',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },
  {
    id: 'TA-15',
    label: 'Denial — records claimed as contractor custody (wrong agency)',
    fromEmail: 'records@dept.gov',
    subject: 'RE: FOIA Request — Not Agency Records',
    body: 'The materials you requested are not federal agency records subject to FOIA. These documents are the proprietary work product of our private contractor and remain in the custody and control of the contractor, not the agency. As they are not agency records, FOIA does not require their disclosure.',
    expectedClassification: 'DENIAL',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },
  {
    id: 'TA-16',
    label: 'Glomar with informant and national security language',
    fromEmail: 'foia@intel.gov',
    subject: 'RE: FOIA Request — Glomar Response',
    body: 'We can neither confirm nor deny the existence of records responsive to your request. Confirmation or denial of the existence of such records would itself reveal the identities of confidential sources and compromise classified national security operations. The Glomar doctrine, established under Phillippi v. CIA, applies to your request in its entirety.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_APPEAL',
    risk: 'high',
  },
  {
    id: 'TA-17',
    label: 'Vaughn index provided — all records withheld (privilege)',
    fromEmail: 'foia@agency.gov',
    subject: 'RE: FOIA Request — Vaughn Index',
    body: 'Attached is a Vaughn index documenting all 47 documents identified as responsive to your FOIA request. After review by agency counsel, all documents have been withheld in full pursuant to the attorney-client privilege and work product doctrine. No documents are being released at this time.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_APPEAL',
    risk: 'high',
  },

  // ── Clarification requests ───────────────────────────────────────────────

  {
    id: 'TA-18',
    label: 'Multi-part clarification with deadline',
    fromEmail: 'foia@dept.gov',
    subject: 'RE: Records Request — Clarification Needed',
    body: 'To process your request efficiently, we need the following information: (1) the full legal names of all officers involved in the incident, (2) a specific date range not to exceed 2 years, (3) the type of records sought (incident reports, body camera footage, internal communications, or all), and (4) the report or case number if known. Please respond within 30 days or your request will be administratively closed.',
    expectedClassification: 'CLARIFICATION_REQUEST',
    expectedAction: 'SEND_CLARIFICATION',
    risk: 'high',
  },
  {
    id: 'TA-19',
    label: 'Identity verification — notarized form required',
    fromEmail: 'records@dept.gov',
    subject: 'RE: Personnel Records Request — Identity Verification Required',
    body: 'To process your request for personnel records, we are required by law to verify your identity and authorization. Please provide: (1) a notarized personal authorization form (attached template), (2) a copy of your government-issued photo ID, and (3) proof of your relationship to the subject if requesting on behalf of another person. We cannot process requests without this documentation.',
    expectedClassification: 'CLARIFICATION_REQUEST',
    expectedAction: 'SEND_CLARIFICATION',
    risk: 'medium',
  },
  {
    id: 'TA-20',
    label: 'Overly broad — too many custodians and years',
    fromEmail: 'foia@largegov.gov',
    subject: 'RE: FOIA Request — Overly Broad',
    body: 'Your request as submitted seeks all communications between all agency employees for a 7-year period, which constitutes an estimated 50 million records across 12 divisions. This request is unduly burdensome and cannot be processed in its current form. We can accommodate requests limited to specific custodians, date ranges not exceeding 6 months, and specific subject matter keywords.',
    expectedClassification: 'DENIAL',
    expectedAction: 'REFORMULATE_REQUEST',
    risk: 'medium',
  },

  // ── Wrong agency / referral ──────────────────────────────────────────────

  {
    id: 'TA-21',
    label: 'Wrong agency — explicit forwarding with contact info',
    fromEmail: 'records@city.gov',
    subject: 'RE: Records Request — Referred to County',
    body: 'Our office is not the custodian of the records you seek. The records you are requesting regarding county law enforcement activities are maintained by the County Sheriff\'s Department. We have forwarded your request to that office. Please follow up with Sheriff\'s Department Records Unit at sheriff.records@countysheriff.gov or (555) 867-5309.',
    expectedClassification: 'WRONG_AGENCY',
    expectedAction: 'RESEARCH_AGENCY',
    risk: 'medium',
  },

  // ── Acknowledgments ──────────────────────────────────────────────────────

  {
    id: 'TA-22',
    label: 'Statutory extension notice (10-day)',
    fromEmail: 'foia@federal.gov',
    subject: 'RE: FOIA Request — Extension Notice',
    body: 'Pursuant to 5 U.S.C. 552(a)(6)(B), we are extending the time limit for processing your FOIA request by 10 working days due to unusual circumstances, specifically the need to search for and collect requested records from separate offices. We will provide a complete response by April 30, 2024.',
    expectedClassification: 'ACKNOWLEDGMENT',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TA-23',
    label: 'Appeal acknowledgment — under review',
    fromEmail: 'foia.appeals@agency.gov',
    subject: 'RE: Administrative Appeal — Received',
    body: 'We have received your administrative appeal dated March 1, 2024, challenging our initial denial of your FOIA request. Your appeal has been assigned docket number AP-2024-0042 and assigned to an appellate officer for review. We will respond within 20 business days as required by statute.',
    expectedClassification: 'ACKNOWLEDGMENT',
    expectedAction: 'NONE',
    risk: 'medium',
  },
  {
    id: 'TA-24',
    label: 'Records transferred to legal department — internal routing',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request — Internal Transfer',
    body: 'Thank you for your public records request. Due to the nature of the records sought, your request has been transferred to our Legal Affairs Division for review and processing. You can expect a response within 15 business days.',
    expectedClassification: 'ACKNOWLEDGMENT',
    expectedAction: 'NONE',
    risk: 'low',
  },

  // ── Hostile ──────────────────────────────────────────────────────────────

  {
    id: 'TA-25',
    label: 'Hostile — threat to seek legal sanctions',
    fromEmail: 'counsel@agency.gov',
    subject: 'RE: FOIA Request — Legal Notice',
    body: 'This is not the first time your organization has filed harassing and bad-faith records requests designed to burden our agency. This pattern of frivolous filings constitutes an abuse of the public records process. We are referring this matter to our Office of General Counsel and reserve all rights to seek sanctions and attorney\'s fees. Your request is denied in its entirety.',
    expectedClassification: 'HOSTILE',
    expectedAction: 'ESCALATE',
    risk: 'high',
  },

  // ── Portal redirect ──────────────────────────────────────────────────────

  {
    id: 'TA-26',
    label: 'Portal redirect — with $5 processing fee mention',
    fromEmail: 'records@city.gov',
    subject: 'RE: Public Records Request — Portal Submission Required',
    body: 'Our agency processes all public records requests through our online portal system. Please visit https://publicrecords.city.gov to submit your request. Note that the portal charges a $5 administrative processing fee at time of submission. All subsequent communications regarding your request will be managed through the portal.',
    expectedClassification: 'PORTAL_REDIRECT',
    expectedAction: 'NONE',
    risk: 'medium',
  },

  // ── Complex multi-signal ─────────────────────────────────────────────────

  {
    id: 'TA-27',
    label: 'Pending litigation — records conditionally withheld (medium strength)',
    fromEmail: 'foia@agency.gov',
    subject: 'RE: FOIA Request — Litigation Hold',
    body: 'The records responsive to your request are currently subject to a litigation hold in connection with ongoing civil proceedings. We are unable to release these materials at this time as doing so may affect the pending litigation. We will reassess the availability of these records upon resolution of the matter.',
    expectedClassification: 'DENIAL',
    expectedAction: 'SEND_REBUTTAL',
    risk: 'high',
  },
  {
    id: 'TA-28',
    label: 'Full denial — privacy + law enforcement, mandatory exemption language',
    fromEmail: 'foia@pd.gov',
    subject: 'RE: FOIA Request — Mandatory Exemption Applies',
    body: 'We have conducted a thorough review of all records responsive to your request. All responsive records contain confidential law enforcement information and personal identifying information of private individuals who have not consented to disclosure. These records are protected by mandatory exemptions under the California Public Records Act and cannot be disclosed under any circumstances. No segregable non-exempt portions exist.',
    expectedClassification: 'DENIAL',
    expectedAction: 'CLOSE_CASE',
    risk: 'high',
  },
  {
    id: 'TA-29',
    label: 'Records available with additional fee for remaining pages',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request — Partial Response with Fee',
    body: 'We are releasing the first 200 responsive pages (attached). An additional 800 pages are available but require $200 in staff processing time and duplication fees. Please authorize this amount and we will produce the remaining documents within 30 days.',
    expectedClassification: 'FEE_QUOTE',
    expectedAction: 'ACCEPT_FEE',
    risk: 'medium',
  },
  {
    id: 'TA-30',
    label: 'Denial — no duty to create (only summary available)',
    fromEmail: 'records@agency.gov',
    subject: 'RE: Records Request — Limited Response',
    body: 'After review, we find that the specific records you requested may not be available in the exact format requested. We may be able to provide a summary of the relevant information rather than the original documents. Additionally, some portions may need to be redacted for privacy reasons. We will follow up with more details.',
    expectedClassification: 'DENIAL',
    expectedAction: 'RESEARCH_AGENCY',
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
    const actualSubtype = simResult?.classification?.denialSubtype;
    const pass = actualAction === tc.expectedAction;

    return {
      tc,
      status: pass ? 'pass' : 'fail',
      actualAction,
      actualClass,
      actualSubtype,
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
          `[ADV] ${f.tc.label} — AI chose ${f.actualAction}, expected ${f.tc.expectedAction}. Risk: ${f.tc.risk}`,
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
  log(`${COLORS.bold}Autobot Advanced Decision Quality Test Runner${COLORS.reset}`);
  log(`${COLORS.dim}${TEST_CASES.length} advanced test cases, batch size ${BATCH_SIZE}${COLORS.reset}`);
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
        log(`       Got:      ${COLORS.red}${r.actualAction}${COLORS.reset}  (classified as: ${r.actualClass}${r.actualSubtype ? '/' + r.actualSubtype : ''})`);
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
    log(`${COLORS.green}All advanced tests passed!${COLORS.reset}`);
  }

  log('');
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
