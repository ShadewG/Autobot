/**
 * Test: 5 Hardest Classification Scenarios
 *
 * Creates test cases + inbound messages, then runs the full Trigger.dev
 * pipeline (classify → constraints → decide → draft → safety) for each.
 *
 * The 5 hardest:
 * 1. Glomar (NCND) denial — agency neither confirms nor denies records exist
 * 2. Partial denial with mixed exemptions — some released, some withheld under multiple exemptions
 * 3. Portal redirect buried in bureaucratic text — URL hidden in long response
 * 4. Hostile refusal disguised as policy — threatening legal action for "frivolous" requests
 * 5. Fee request with complex multi-item breakdown — ambiguous whether fee or denial
 *
 * Usage:
 *   npx tsx scripts/_test_5_hardest_classifications.ts
 */

// Load env BEFORE any imports that might trigger db connections
import { config } from "dotenv";
config({ path: ".env.test", override: true });

// Force DATABASE_URL to the public URL for local testing
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

// Lazy-loaded modules (set in main() via dynamic import)
let loadContext: any;
let classifyInbound: any;
let updateConstraints: any;
let decideNextAction: any;
let draftResponse: any;
let safetyCheck: any;
let db: any;
let DRAFT_REQUIRED_ACTIONS: string[];

// ─── Test Email Scenarios ────────────────────────────────────────────

interface TestScenario {
  name: string;
  expectedClassification: string;
  expectedDenialSubtype?: string;
  caseData: {
    case_name: string;
    subject_name: string;
    agency_name: string;
    agency_email: string;
    state: string;
    requested_records: string[];
  };
  email: {
    from_email: string;
    subject: string;
    body_text: string;
  };
}

const scenarios: TestScenario[] = [
  // ────────────────────────────────────────────────────────────────────
  // 1. GLOMAR / NCND — agency neither confirms nor denies existence
  // ────────────────────────────────────────────────────────────────────
  {
    name: "Glomar / NCND Denial",
    expectedClassification: "DENIAL",
    expectedDenialSubtype: "glomar_ncnd",
    caseData: {
      case_name: "Test Glomar - DEA Surveillance Records",
      subject_name: "Carlos Mendez",
      agency_name: "Drug Enforcement Administration",
      agency_email: "foia@dea.gov",
      state: "DC",
      requested_records: [
        "Surveillance records related to Carlos Mendez",
        "Wiretap authorizations 2022-2024",
        "Confidential informant reports mentioning Carlos Mendez",
      ],
    },
    email: {
      from_email: "foia@dea.gov",
      subject: "RE: FOIA Request #DEA-2024-00847 - Mendez",
      body_text: `Dear Mr. Hylton,

This is in response to your Freedom of Information Act (FOIA) request dated January 15, 2025, seeking surveillance records, wiretap authorizations, and confidential informant reports related to Carlos Mendez.

After careful review, the Drug Enforcement Administration can neither confirm nor deny the existence of records responsive to your request. The mere acknowledgment of the existence or nonexistence of such records would, in and of itself, constitute an unwarranted invasion of personal privacy and could reasonably be expected to interfere with enforcement proceedings.

This response is made pursuant to 5 U.S.C. § 552(b)(7)(A), (b)(7)(C), and (b)(7)(D) of the Freedom of Information Act, which protects from disclosure records or information compiled for law enforcement purposes, the release of which could reasonably be expected to:

(A) interfere with enforcement proceedings;
(C) constitute an unwarranted invasion of personal privacy; and
(D) disclose the identity of a confidential source.

Additionally, to the extent that any records might exist, they would also be protected under 5 U.S.C. § 552(b)(1), as they may contain classified national security information.

You have the right to appeal this determination within 90 days to the Office of Information Policy, U.S. Department of Justice, Suite 11050, 1425 New York Avenue, NW, Washington, DC 20530-0001.

Sincerely,
Katherine L. Harris
Chief, FOIA/Privacy Act Unit
Drug Enforcement Administration`,
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // 2. PARTIAL DENIAL with mixed exemptions — some released, some withheld
  // ────────────────────────────────────────────────────────────────────
  {
    name: "Partial Denial - Mixed Exemptions",
    expectedClassification: "PARTIAL_APPROVAL",
    // Multiple exemptions cited: privacy (7(1)(b), 7(1)(c)) AND investigation (7(1)(d)(iv))
    // Either subtype is acceptable since the email genuinely covers both
    expectedDenialSubtype: "ongoing_investigation|privacy_exemption",
    caseData: {
      case_name: "Test Partial - Chicago PD Use of Force",
      subject_name: "Marcus Johnson",
      agency_name: "Chicago Police Department",
      agency_email: "foia@chicagopolice.org",
      state: "IL",
      requested_records: [
        "Body-worn camera footage from incident on 11/15/2024",
        "Tactical Response Reports (TRR)",
        "Officer disciplinary records for Officers Badge #4521 and #3887",
        "Internal affairs investigation file #IA-2024-0892",
      ],
    },
    email: {
      from_email: "foia@chicagopolice.org",
      subject: "FOIA Response - Request #2024-P-08432 (Partial Release)",
      body_text: `Dear Mr. Hylton,

The Chicago Police Department has completed its search for records responsive to your request filed under the Illinois Freedom of Information Act (5 ILCS 140) regarding the incident involving Marcus Johnson on November 15, 2024.

RECORDS RELEASED:
We are releasing the following responsive records, with certain redactions as noted:

1. Tactical Response Reports (TRR) for Officers Badge #4521 and #3887 — Released with redactions to home addresses, personal phone numbers, and social security numbers pursuant to 5 ILCS 140/7(1)(b) (privacy) and 5 ILCS 140/7(1)(c) (personal information).

RECORDS WITHHELD:
2. Body-worn camera footage — DENIED. This footage is being withheld in its entirety as it pertains to an active internal affairs investigation and its release would compromise the integrity of the ongoing investigation. 5 ILCS 140/7(1)(d)(iv).

3. Officer disciplinary records — PARTIALLY DENIED. Summary disciplinary outcomes are included with the TRR release. Complete disciplinary files are exempt under 5 ILCS 140/7(1)(n) (records relating to the adjudication of employee grievances or disciplinary cases), however sustained complaint summaries from COPA are available through their separate FOIA process.

4. Internal affairs investigation file #IA-2024-0892 — DENIED in its entirety pursuant to 5 ILCS 140/7(1)(d)(iv) (law enforcement records that would obstruct an ongoing investigation) and 5 ILCS 140/7(1)(c)(privacy of the complainant).

The TRR documents totaling 14 pages are attached to this email as a PDF.

You have the right to seek review of this partial denial by filing a Request for Review with the Illinois Attorney General's Public Access Counselor within 60 days.

Records Division
Chicago Police Department`,
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // 3. PORTAL REDIRECT buried in bureaucratic text
  // ────────────────────────────────────────────────────────────────────
  {
    name: "Portal Redirect (Buried in Bureaucratic Text)",
    expectedClassification: "PORTAL_REDIRECT",
    caseData: {
      case_name: "Test Portal - LA County Sheriff Arrest Records",
      subject_name: "David Park",
      agency_name: "Los Angeles County Sheriff's Department",
      agency_email: "records@lasd.org",
      state: "CA",
      requested_records: [
        "Arrest report for David Park, booking #2024-LA-88291",
        "Incident report from 09/22/2024",
        "Mugshot/booking photo",
      ],
    },
    email: {
      from_email: "records@lasd.org",
      subject: "RE: Public Records Act Request - Park, David",
      body_text: `Dear Mr. Hylton,

Thank you for your California Public Records Act request regarding David Park. We appreciate your patience.

Please be advised that due to our department's transition to a new records management system effective January 2025, all public records requests must now be submitted through our designated online portal. Email submissions are no longer being processed through this inbox and will not receive further follow-up.

Our department has implemented the GovQA platform to streamline the request process and provide real-time status updates. The Records Unit staff will not be able to process requests received via email, phone, or mail until further notice.

To submit your request, please visit:
https://lasd.govqa.us/WEBAPP/_rs/(S(2kfmp1nqxg3zjqrmcfxkv0oy))/RequestSubmission.aspx

You will need to create an account if you don't already have one. Once logged in, select "California Public Records Act Request" as the request type, and re-enter the details of your original request. Please reference your original email dated January 8, 2025 in the description field so our team can prioritize your submission.

Note: Standard processing times apply from the date of portal submission, not the original email date. Under the California Public Records Act (Gov. Code § 6253), we will respond within 10 calendar days of portal receipt.

If you have difficulty accessing the portal, please contact our Help Desk at (323) 526-5541 during business hours (M-F, 8am-5pm PST).

Regards,
Public Records Unit
Los Angeles County Sheriff's Department`,
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // 4. HOSTILE refusal disguised as policy language
  // ────────────────────────────────────────────────────────────────────
  {
    name: "Hostile Refusal (Disguised as Policy)",
    expectedClassification: "HOSTILE",
    caseData: {
      case_name: "Test Hostile - Small Town PD Records",
      subject_name: "Elena Vasquez",
      agency_name: "Millbrook Township Police Department",
      agency_email: "chief@millbrookpd.gov",
      state: "NJ",
      requested_records: [
        "All use-of-force reports from 2023-2024",
        "Officer complaint files",
        "Internal policies on use of force",
        "Dash cam and body cam footage from arrest of Elena Vasquez on 06/12/2024",
      ],
    },
    email: {
      from_email: "chief@millbrookpd.gov",
      subject: "RE: OPRA Request - Vasquez Records",
      body_text: `Mr. Hylton,

I have reviewed your so-called "records request" and frankly I find it to be an abuse of the Open Public Records Act. Your request for "all use-of-force reports" and "officer complaint files" spanning two years is patently overbroad and appears designed to harass this department rather than serve any legitimate public interest.

This department serves a community of 4,200 residents with 8 sworn officers. We do not have the resources to entertain fishing expeditions from out-of-state requestors who are clearly not members of this community and have no connection to Millbrook Township.

Furthermore, I want to make something very clear: this department takes a dim view of individuals who weaponize public records laws to interfere with police operations. We have consulted with our township attorney, and if you continue to submit requests of this nature, we will pursue all available legal remedies including seeking a declaration that you are a frivolous requestor under N.J.S.A. 47:1A-7, which would permanently bar you from making OPRA requests to any agency in this state.

As to the Vasquez arrest footage, that matter is the subject of pending municipal court proceedings (Case #2024-MC-0412) and absolutely nothing will be released while litigation is pending. Period.

Do not contact this department again regarding this matter.

Chief Robert D. Thornton
Millbrook Township Police Department`,
    },
  },

  // ────────────────────────────────────────────────────────────────────
  // 5. FEE REQUEST with complex multi-item breakdown (ambiguous)
  // ────────────────────────────────────────────────────────────────────
  {
    name: "Fee Quote - Complex Multi-Item Breakdown",
    expectedClassification: "FEE_QUOTE",
    caseData: {
      case_name: "Test Fee - State Police Accident Reports",
      subject_name: "Angela Torres",
      agency_name: "Pennsylvania State Police",
      agency_email: "righttoknow@pa.gov",
      state: "PA",
      requested_records: [
        "Accident reconstruction report for crash on I-76, 08/03/2024",
        "Responding officer body camera footage",
        "911 dispatch audio recordings",
        "Toxicology/BAC results for all drivers involved",
        "Photographs taken at the scene",
      ],
    },
    email: {
      from_email: "righttoknow@pa.gov",
      subject: "RTKL Response - Fee Estimate - Request #RTK-2025-0193 (Torres)",
      body_text: `Dear Mr. Hylton,

This letter is in response to your Right-to-Know Law (RTKL) request dated January 20, 2025, for records related to the motor vehicle accident involving Angela Torres on Interstate 76 on August 3, 2024.

The Pennsylvania State Police has identified potentially responsive records. However, pursuant to 65 P.S. § 67.1307, we are required to provide you with a fee estimate before proceeding with production. The estimated costs are as follows:

ITEM-BY-ITEM FEE BREAKDOWN:

1. Accident Reconstruction Report (47 pages)
   Duplication: 47 pages × $0.25/page = $11.75

2. Body Camera Footage (approx. 2 hrs 14 min across 3 officers)
   Media duplication fee: $15.00 per officer × 3 = $45.00
   Redaction of third-party PII (est. 4 hours): $28.63/hr × 4 = $114.52

3. 911 Dispatch Audio (3 separate calls, total 22 minutes)
   Audio retrieval and export: $35.00 flat fee
   Third-party voice redaction: $25.00

4. Toxicology/BAC Results
   These records are maintained by the Allegheny County Medical Examiner and are NOT held by the Pennsylvania State Police. You may need to submit a separate request to their office at forensics@alleghenycounty.us.

5. Scene Photographs (187 photographs)
   Digital export: $0.10/photo × 187 = $18.70
   Review for exempt content (est. 2 hours): $28.63/hr × 2 = $57.26

TOTAL ESTIMATED FEE: $307.23

A deposit of 50% ($153.62) is required before we begin processing. The final amount may be lower if redaction takes less time than estimated.

Please respond within 30 days indicating whether you wish to:
(a) Proceed with the full request and submit the deposit
(b) Narrow the scope of your request to reduce costs
(c) Withdraw the request

Payment can be made by check payable to "Commonwealth of Pennsylvania" or online at pay.pa.gov/rtkl.

Please note that the toxicology/BAC records (Item 4) are not in our possession and are not included in this fee estimate.

Sincerely,
Lt. Patricia Morales
RTKL Officer
Pennsylvania State Police, Troop A`,
    },
  },
];

// ─── Test Runner ─────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function check(label: string, actual: string, expected: string): boolean {
  // Support pipe-separated expected values (e.g., "a|b" matches either "a" or "b")
  const acceptableValues = expected.split("|");
  const pass = acceptableValues.includes(actual);
  const icon = pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const detail = pass
    ? `${GREEN}${actual}${RESET}`
    : `${RED}${actual}${RESET} (expected ${YELLOW}${expected}${RESET})`;
  console.log(`  ${icon} ${label}: ${detail}`);
  return pass;
}

async function createTestCase(scenario: TestScenario): Promise<{ caseId: number; messageId: number }> {
  const ts = Date.now();

  // Create case
  const caseRow = await db.createCase({
    notion_page_id: `test-hardclass-${ts}`,
    case_name: scenario.caseData.case_name,
    subject_name: scenario.caseData.subject_name,
    agency_name: scenario.caseData.agency_name,
    agency_email: scenario.caseData.agency_email,
    state: scenario.caseData.state,
    requested_records: scenario.caseData.requested_records,
    status: "awaiting_response",
  });

  // Create thread
  const threadRow = await db.createEmailThread({
    case_id: caseRow.id,
    thread_id: `thread-test-${ts}`,
    subject: scenario.email.subject,
    agency_email: scenario.caseData.agency_email,
  });

  // Create an outbound message first (initial request context)
  await db.createMessage({
    thread_id: threadRow.id,
    case_id: caseRow.id,
    message_id: `<outbound-test-${ts}@matcher.com>`,
    direction: "outbound",
    from_email: "samuel@matcher.com",
    to_email: scenario.caseData.agency_email,
    subject: `Public Records Request - ${scenario.caseData.subject_name}`,
    body_text: `Dear Records Custodian,\n\nPursuant to the applicable public records law, I am requesting the following records:\n\n${scenario.caseData.requested_records.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\nThank you for your prompt attention.\n\nSamuel Hylton`,
    message_type: "initial_request",
    sent_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  });

  // Create inbound message (the agency response we're testing)
  const msgRow = await db.createMessage({
    thread_id: threadRow.id,
    case_id: caseRow.id,
    message_id: `<inbound-test-${ts}@agency.gov>`,
    direction: "inbound",
    from_email: scenario.email.from_email,
    to_email: "samuel@matcher.com",
    subject: scenario.email.subject,
    body_text: scenario.email.body_text,
    message_type: "response",
    received_at: new Date(),
  });

  return { caseId: caseRow.id, messageId: msgRow.id };
}

async function runPipeline(
  scenario: TestScenario,
  caseId: number,
  messageId: number
): Promise<{
  classificationPass: boolean;
  denialSubtypePass: boolean;
  decision: string;
  reasoning: string[];
  draftSubject?: string;
  safetyPassed?: boolean;
}> {
  // Step 1: Load context
  const context = await loadContext(caseId, messageId);

  // Step 2: Classify
  const classification = await classifyInbound(context, messageId, "INBOUND_MESSAGE");

  console.log(`\n${CYAN}  Classification details:${RESET}`);
  console.log(`    Confidence: ${classification.confidence}`);
  console.log(`    Sentiment: ${classification.sentiment}`);
  console.log(`    Requires response: ${classification.requiresResponse}`);
  if (classification.extractedFeeAmount != null) console.log(`    Fee: $${classification.extractedFeeAmount}`);
  if (classification.portalUrl) console.log(`    Portal URL: ${classification.portalUrl}`);
  if (classification.denialSubtype) console.log(`    Denial subtype: ${classification.denialSubtype}`);
  if ((classification as any).detected_exemption_citations?.length) {
    console.log(`    Exemptions cited: ${(classification as any).detected_exemption_citations.join(", ")}`);
  }
  if ((classification as any).decision_evidence_quotes?.length) {
    console.log(`    Evidence quotes:`);
    (classification as any).decision_evidence_quotes.forEach((q: string) =>
      console.log(`      "${q}"`)
    );
  }

  const classificationPass = check(
    "Classification",
    classification.classification,
    scenario.expectedClassification
  );

  let denialSubtypePass = true;
  if (scenario.expectedDenialSubtype) {
    denialSubtypePass = check(
      "Denial subtype",
      classification.denialSubtype || "null",
      scenario.expectedDenialSubtype
    );
  }

  // Step 3: Update constraints
  const { constraints, scopeItems } = await updateConstraints(
    caseId,
    classification.classification,
    classification.extractedFeeAmount,
    messageId,
    context.constraints,
    context.scopeItems
  );
  console.log(`${DIM}  Constraints: ${constraints.join(", ") || "none"}${RESET}`);

  // Step 4: Decide
  const decision = await decideNextAction(
    caseId,
    classification.classification,
    constraints,
    classification.extractedFeeAmount,
    classification.sentiment,
    context.autopilotMode,
    "INBOUND_MESSAGE",
    classification.requiresResponse,
    classification.portalUrl,
    classification.suggestedAction,
    classification.reasonNoResponse,
    classification.denialSubtype
  );
  console.log(`  Decision: ${BOLD}${decision.actionType}${RESET}`);
  console.log(`  Auto-execute: ${decision.canAutoExecute}, Requires human: ${decision.requiresHuman}`);
  decision.reasoning.forEach((r: string) => console.log(`    ${DIM}- ${r}${RESET}`));

  let draftSubject: string | undefined;
  let safetyPassed: boolean | undefined;

  // Step 5: Draft (if needed)
  const needsDraft =
    (DRAFT_REQUIRED_ACTIONS || []).includes(decision.actionType) ||
    ["RESEARCH_AGENCY", "REFORMULATE_REQUEST"].includes(decision.actionType);

  if (needsDraft && decision.actionType !== "NONE" && decision.actionType !== "ESCALATE") {
    try {
      console.log(`${DIM}  Drafting ${decision.actionType}...${RESET}`);
      const draft = await draftResponse(
        caseId,
        decision.actionType,
        constraints,
        scopeItems,
        classification.extractedFeeAmount,
        decision.adjustmentInstruction,
        messageId
      );
      draftSubject = draft.subject;
      console.log(`  Draft subject: ${draft.subject || "(none)"}`);
      console.log(`  Draft preview: ${(draft.bodyText || "").substring(0, 150)}...`);

      // Step 6: Safety check
      const safety = await safetyCheck(
        draft.bodyText,
        draft.subject,
        decision.actionType,
        constraints,
        scopeItems
      );
      safetyPassed = safety.riskFlags.length === 0;
      console.log(
        `  Safety: ${safetyPassed ? `${GREEN}PASS${RESET}` : `${YELLOW}FLAGS: ${safety.riskFlags.join(", ")}${RESET}`}`
      );
      if (safety.warnings.length) {
        console.log(`  Warnings: ${safety.warnings.join(", ")}`);
      }
    } catch (draftErr: any) {
      console.log(`  ${YELLOW}Draft/safety skipped: ${draftErr.message}${RESET}`);
    }
  }

  return {
    classificationPass,
    denialSubtypePass,
    decision: decision.actionType,
    reasoning: decision.reasoning,
    draftSubject,
    safetyPassed,
  };
}

// ─── Cleanup helper ──────────────────────────────────────────────────

async function cleanupTestCase(caseId: number) {
  try {
    await db.query("DELETE FROM response_analysis WHERE case_id = $1", [caseId]);
    await db.query("DELETE FROM proposals WHERE case_id = $1", [caseId]);
    await db.query("DELETE FROM messages WHERE case_id = $1", [caseId]);
    await db.query("DELETE FROM email_threads WHERE case_id = $1", [caseId]);
    await db.query("DELETE FROM follow_up_schedule WHERE case_id = $1", [caseId]);
    await db.query("DELETE FROM cases WHERE id = $1", [caseId]);
  } catch (err: any) {
    console.log(`${DIM}  Cleanup for case ${caseId}: ${err.message}${RESET}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  // Dynamic imports after env is configured
  ({ loadContext } = await import("../trigger/steps/load-context"));
  ({ classifyInbound } = await import("../trigger/steps/classify-inbound"));
  ({ updateConstraints } = await import("../trigger/steps/update-constraints"));
  ({ decideNextAction } = await import("../trigger/steps/decide-next-action"));
  ({ draftResponse } = await import("../trigger/steps/draft-response"));
  ({ safetyCheck } = await import("../trigger/steps/safety-check"));
  db = require("../services/database");
  ({ DRAFT_REQUIRED_ACTIONS } = require("../constants/action-types"));

  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  5 Hardest Classification Tests — Full Pipeline${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n`);

  const results: { name: string; pass: boolean; decision: string }[] = [];
  const createdCaseIds: number[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    console.log(`\n${BOLD}━━━ ${i + 1}/${scenarios.length}: ${scenario.name} ━━━${RESET}`);
    console.log(`${DIM}  Expected: ${scenario.expectedClassification}${scenario.expectedDenialSubtype ? ` / ${scenario.expectedDenialSubtype}` : ""}${RESET}`);

    let caseId: number | null = null;
    try {
      // Create test data
      const testData = await createTestCase(scenario);
      caseId = testData.caseId;
      createdCaseIds.push(caseId);
      console.log(`${DIM}  Created case #${caseId}, message #${testData.messageId}${RESET}`);

      // Run pipeline
      const result = await runPipeline(scenario, testData.caseId, testData.messageId);
      const overallPass = result.classificationPass && result.denialSubtypePass;
      results.push({ name: scenario.name, pass: overallPass, decision: result.decision });
    } catch (err: any) {
      console.log(`${RED}  ERROR: ${err.message}${RESET}`);
      console.log(`${DIM}  ${err.stack?.split("\n").slice(1, 4).join("\n  ")}${RESET}`);
      results.push({ name: scenario.name, pass: false, decision: "ERROR" });
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────
  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  RESULTS SUMMARY${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n`);

  let passed = 0;
  for (const r of results) {
    const icon = r.pass ? `${GREEN}✓ PASS${RESET}` : `${RED}✗ FAIL${RESET}`;
    console.log(`  ${icon}  ${r.name} → ${r.decision}`);
    if (r.pass) passed++;
  }

  console.log(
    `\n  ${passed === results.length ? GREEN : YELLOW}${passed}/${results.length} passed${RESET}\n`
  );

  // Cleanup test data
  console.log(`${DIM}Cleaning up ${createdCaseIds.length} test cases...${RESET}`);
  for (const id of createdCaseIds) {
    await cleanupTestCase(id);
  }
  console.log(`${DIM}Cleanup complete.${RESET}\n`);

  try {
    await db.close();
  } catch (e: any) {
    /* ignore */
  }

  process.exit(passed === results.length ? 0 : 1);
}

main();
