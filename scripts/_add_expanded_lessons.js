#!/usr/bin/env node
/**
 * Add expanded AI decision lessons to existing DB.
 * Safe to run multiple times — checks for duplicates by trigger_pattern before inserting.
 *
 * Usage: node scripts/_add_expanded_lessons.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL });

const newLessons = [
    // Denial Handling (5)
    {
        category: 'denial',
        trigger: 'overly_broad denial narrow',
        lesson: 'When agency says request is "too broad" or asks to narrow scope, propose REFORMULATE_REQUEST with a more specific request — NOT SEND_REBUTTAL. Narrowing the request is more productive than arguing.',
        priority: 8
    },
    {
        category: 'denial',
        trigger: 'retention_expired destroyed purged no_records',
        lesson: 'When agency says records were destroyed per retention schedule, propose SEND_CLARIFICATION asking for: (1) the retention schedule citation, (2) destruction certification/log, (3) whether any indexes or metadata survive. If none available, propose CLOSE_CASE.',
        priority: 8
    },
    {
        category: 'denial',
        trigger: 'denial segregable partial redacted',
        lesson: 'On ANY denial, always ask for segregable/releasable portions with redactions. Most state laws require agencies to release non-exempt portions rather than deny the entire request. Propose SEND_REBUTTAL citing the state segregability requirement.',
        priority: 7
    },
    {
        category: 'denial',
        trigger: 'denial wrong_agency forwarded',
        lesson: 'When agency says "wrong agency" or "not our jurisdiction," propose RESEARCH_AGENCY to identify the correct custodian. Also ask the denying agency to forward the request or provide the correct agency\'s contact info.',
        priority: 7
    },
    {
        category: 'denial',
        trigger: 'denial dismissed_send_rebuttal tried_send_rebuttal',
        lesson: 'If SEND_REBUTTAL was already tried or dismissed for this case, do NOT propose another rebuttal. Instead propose REFORMULATE_REQUEST (try a different angle), RESEARCH_AGENCY (maybe wrong custodian), or ESCALATE.',
        priority: 6
    },
    // Fee Handling (4)
    {
        category: 'fee',
        trigger: 'fee excessive_fee high_fee negotiate',
        lesson: 'When a fee exceeds $500 or seems excessive/unreasonable, propose NEGOTIATE_FEE with: (1) request line-item cost breakdown, (2) propose narrowing scope to reduce costs, (3) cite public interest fee waiver if applicable. Do NOT just accept high fees.',
        priority: 8
    },
    {
        category: 'fee',
        trigger: 'fee fee_waiver_eligible public interest documentary media',
        lesson: 'When case involves documentary, journalism, or public interest purpose, ALWAYS request a public interest fee waiver before accepting any fee. Propose NEGOTIATE_FEE citing the public interest/media exemption from fees.',
        priority: 7
    },
    {
        category: 'fee',
        trigger: 'fee declined dismissed_accept_fee dismissed_negotiate_fee',
        lesson: 'If both ACCEPT_FEE and NEGOTIATE_FEE were dismissed, the fee may be genuinely unreasonable. Propose DECLINE_FEE explaining the fee creates an unreasonable barrier to public records access, or REFORMULATE_REQUEST to narrow scope and reduce costs.',
        priority: 7
    },
    {
        category: 'fee',
        trigger: 'fee has_fee_quote no_records denial',
        lesson: 'When agency responds with BOTH a fee quote AND a denial in the same message, address the denial first with SEND_REBUTTAL. Do not propose ACCEPT_FEE for a fee attached to a denied request — the denial must be resolved first.',
        priority: 6
    },
    // Portal Handling (3)
    {
        category: 'portal',
        trigger: 'portal has_portal dismissed_submit_portal tried_submit_portal',
        lesson: 'If SUBMIT_PORTAL was already attempted or dismissed for this case, do NOT propose SUBMIT_PORTAL again. Switch to SEND_FOLLOWUP via email, or ESCALATE for manual portal submission.',
        priority: 8
    },
    {
        category: 'portal',
        trigger: 'portal duplicate_request already submitted',
        lesson: 'When the portal or agency says a request was already submitted or is a duplicate, propose SEND_CLARIFICATION asking for the existing request number/tracking ID, or NONE if the original request is being processed. Do NOT resubmit.',
        priority: 7
    },
    {
        category: 'portal',
        trigger: 'portal acknowledgment received',
        lesson: 'When agency acknowledges receipt of a portal submission, this is NOT a denial or problem. Propose NONE — wait for the agency to process the request. Do not send follow-up emails if the portal submission was successful.',
        priority: 6
    },
    // Follow-up Strategy (3)
    {
        category: 'followup',
        trigger: 'awaiting_response multiple_followups has_followups',
        lesson: 'After 2+ follow-ups with no response, do NOT keep sending SEND_FOLLOWUP. Propose ESCALATE for phone call or formal complaint, or RESEARCH_AGENCY to verify we have the right contact/email. Repeated emails get ignored.',
        priority: 8
    },
    {
        category: 'followup',
        trigger: 'acknowledgment awaiting_response',
        lesson: 'When agency has already acknowledged receipt ("we received your request"), do NOT send SEND_FOLLOWUP too early. Propose NONE and wait at least 10 business days from acknowledgment before following up.',
        priority: 7
    },
    {
        category: 'followup',
        trigger: 'wrong_agency forwarded',
        lesson: 'When a wrong-agency response includes "we forwarded your request to [agency]" or "contact [agency]", do NOT send SEND_FOLLOWUP to the original agency. Instead propose RESEARCH_AGENCY to target the new agency, or NONE if they confirmed forwarding.',
        priority: 7
    },
    // Partial Approval / Records Delivery (3)
    {
        category: 'general',
        trigger: 'partial_approval released withheld',
        lesson: 'When agency releases some records but withholds others, ALWAYS propose RESPOND_PARTIAL_APPROVAL — accept the released records AND challenge each withheld category separately citing segregability requirements. Never just accept a partial release without challenging withheld portions.',
        priority: 8
    },
    {
        category: 'general',
        trigger: 'records_ready download attached',
        lesson: 'When agency says records are ready, attached, or available for download/pickup, propose CLOSE_CASE with status "records_received". Do NOT propose SEND_FOLLOWUP or SEND_REBUTTAL when records have been provided.',
        priority: 7
    },
    {
        category: 'general',
        trigger: 'partial_approval has_fee_quote fee',
        lesson: 'When partial records come with a fee for remaining records, propose RESPOND_PARTIAL_APPROVAL that: (1) acknowledges received records, (2) addresses the fee (accept if reasonable, negotiate if high), (3) challenges any withheld portions. Handle all three in one response.',
        priority: 6
    },
    // Clarification / Agency Communication (3)
    {
        category: 'general',
        trigger: 'clarification_request additional information please provide',
        lesson: 'When agency asks for clarification or more details, propose SEND_CLARIFICATION. Be cooperative — provide exactly what they ask for. A quick helpful response moves the case forward faster than arguing about whether the original request was sufficient.',
        priority: 7
    },
    {
        category: 'general',
        trigger: 'hostile cease stop contacting harassment',
        lesson: 'When agency response is hostile ("stop contacting us", "harassment"), propose ESCALATE immediately. Do NOT send automated responses to hostile agencies — a human should review and decide whether to send a formal appeal or involve legal counsel.',
        priority: 7
    },
    {
        category: 'general',
        trigger: 'appeal attorney general dismissed_send_rebuttal',
        lesson: 'After a rebuttal has been sent AND dismissed or denied again, consider proposing ESCALATE with a note to file a formal appeal with the state attorney general or records ombudsman. This is the appropriate next step after direct negotiation fails.',
        priority: 6
    },
    // Strategic / Meta (3)
    {
        category: 'routing',
        trigger: 'denial no_records no_portal submit_portal',
        lesson: 'NEVER propose SUBMIT_PORTAL for a "no records" denial. "No records found" means the agency searched and found nothing — resubmitting the same request through a portal won\'t change that. Propose RESEARCH_AGENCY or REFORMULATE_REQUEST instead.',
        priority: 9
    },
    {
        category: 'general',
        trigger: 'multiple_dismissals dismissed',
        lesson: 'When 3+ proposals have been dismissed for a single case, propose ESCALATE. The AI is not finding an acceptable action, and a human needs to assess the situation directly. Continuing to propose will frustrate the user.',
        priority: 8
    },
    {
        category: 'general',
        trigger: 'tried_send_followup tried_send_rebuttal tried_negotiate_fee dismissed',
        lesson: 'When multiple different action types have been tried AND dismissed, the case likely needs a fundamentally different approach. Propose ESCALATE with a summary of what was tried and why each failed, so the human has full context.',
        priority: 7
    }
];

async function addLessons() {
    let added = 0;
    let skipped = 0;

    for (const l of newLessons) {
        // Check for existing lesson with same trigger_pattern
        const existing = await pool.query(
            'SELECT id FROM ai_decision_lessons WHERE trigger_pattern = $1 AND active = true',
            [l.trigger]
        );

        if (existing.rows.length > 0) {
            console.log(`  SKIP: [${l.category}] "${l.trigger}" (already exists, id=${existing.rows[0].id})`);
            skipped++;
            continue;
        }

        await pool.query(
            'INSERT INTO ai_decision_lessons (category, trigger_pattern, lesson, source, priority) VALUES ($1, $2, $3, $4, $5)',
            [l.category, l.trigger, l.lesson, 'manual', l.priority]
        );
        console.log(`  ADD:  [${l.category}] ${l.lesson.substring(0, 70)}...`);
        added++;
    }

    console.log(`\nDone: ${added} added, ${skipped} skipped (duplicates)`);
    await pool.end();
}

addLessons().catch(e => { console.error(e); process.exit(1); });
