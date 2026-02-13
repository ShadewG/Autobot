#!/usr/bin/env node
/**
 * End-to-end test of AI decision memory.
 *
 * 1. Run triage on a real denial case (case #60) — check if seed lessons prevent SUBMIT_PORTAL
 * 2. Simulate a dismissal → verify auto-lesson gets created
 * 3. Run triage again on same case → verify it references the learned lesson
 * 4. Test with case #42 (failed portal) → verify portal-failure lessons kick in
 */
require('dotenv').config();
const db = require('../services/database');
const aiService = require('../services/ai-service');
const decisionMemory = require('../services/decision-memory-service');

async function test() {
    console.log('='.repeat(70));
    console.log('TEST 1: Case #60 (Springhill PD — DENIAL case, no portal)');
    console.log('Expected: SEND_REBUTTAL or CLOSE_CASE, NOT SUBMIT_PORTAL');
    console.log('='.repeat(70));

    const case60 = await db.getCaseById(60);
    const msgs60 = await db.getMessagesByCaseId(60, 10);
    const props60 = (await db.query(
        `SELECT action_type, status, reasoning FROM proposals WHERE case_id = 60 ORDER BY created_at DESC LIMIT 5`
    )).rows;

    console.log(`\nCase: ${case60.case_name}`);
    console.log(`Status: ${case60.status}`);
    console.log(`Portal URL: ${case60.portal_url || 'NONE'}`);
    console.log(`Messages: ${msgs60.length}`);
    console.log(`Prior proposals: ${props60.map(p => `${p.action_type}(${p.status})`).join(', ')}`);

    // Check what lessons match BEFORE triage
    const lessons60 = await decisionMemory.getRelevantLessons(case60, { messages: msgs60, priorProposals: props60 });
    console.log(`\nRelevant lessons found: ${lessons60.length}`);
    for (const l of lessons60) {
        console.log(`  [${l.category}] (priority ${l.priority}, relevance ${l.relevance_score}): ${l.lesson.substring(0, 100)}`);
    }

    // Run triage
    console.log('\nRunning AI triage...');
    const result60 = await aiService.triageStuckCase(case60, msgs60, props60);
    console.log(`\nAI DECISION: ${result60.actionType} (confidence: ${result60.confidence})`);
    console.log(`Summary: ${result60.summary}`);
    console.log(`Recommendation: ${result60.recommendation}`);

    const pass1 = result60.actionType !== 'SUBMIT_PORTAL';
    console.log(`\n${pass1 ? '✅ PASS' : '❌ FAIL'}: AI ${pass1 ? 'did NOT' : 'incorrectly'} propose SUBMIT_PORTAL for denial case`);

    // ===================================================================
    console.log('\n' + '='.repeat(70));
    console.log('TEST 2: Simulate dismissal → auto-learn');
    console.log('='.repeat(70));

    // Count lessons before
    const beforeCount = (await decisionMemory.listLessons()).length;
    console.log(`Lessons before dismissal: ${beforeCount}`);

    // Simulate auto-learning from a dismissal
    const learnedId = await decisionMemory.learnFromOutcome({
        category: 'denial',
        triggerPattern: `dismissed SUBMIT_PORTAL for Springhill Police Department`,
        lesson: `Do not propose SUBMIT_PORTAL for case #60 (Springhill PD denial) — human dismissed it. Agency denied the request citing body camera and 911 materials. Use SEND_REBUTTAL instead.`,
        sourceCaseId: 60,
        priority: 6
    });

    const afterCount = (await decisionMemory.listLessons()).length;
    console.log(`Lessons after dismissal: ${afterCount}`);
    console.log(`New lesson ID: ${learnedId}`);
    console.log(`${afterCount > beforeCount ? '✅ PASS' : '❌ FAIL'}: Auto-lesson was created`);

    // ===================================================================
    console.log('\n' + '='.repeat(70));
    console.log('TEST 3: Re-run triage on case #60 — should reference new lesson');
    console.log('='.repeat(70));

    const lessons60b = await decisionMemory.getRelevantLessons(case60, { messages: msgs60, priorProposals: props60 });
    console.log(`\nRelevant lessons (round 2): ${lessons60b.length}`);
    const hasNewLesson = lessons60b.some(l => l.id === learnedId);
    console.log(`Contains newly learned lesson: ${hasNewLesson ? '✅ YES' : '❌ NO'}`);
    for (const l of lessons60b) {
        const marker = l.id === learnedId ? ' ← NEW' : '';
        console.log(`  [${l.category}] (priority ${l.priority}, relevance ${l.relevance_score}): ${l.lesson.substring(0, 100)}${marker}`);
    }

    console.log('\nRunning AI triage (round 2)...');
    const result60b = await aiService.triageStuckCase(case60, msgs60, props60);
    console.log(`\nAI DECISION: ${result60b.actionType} (confidence: ${result60b.confidence})`);
    console.log(`Summary: ${result60b.summary}`);
    console.log(`Recommendation: ${result60b.recommendation}`);

    const pass3 = result60b.actionType !== 'SUBMIT_PORTAL';
    console.log(`\n${pass3 ? '✅ PASS' : '❌ FAIL'}: AI still avoids SUBMIT_PORTAL after learning`);

    // ===================================================================
    console.log('\n' + '='.repeat(70));
    console.log('TEST 4: Case #42 (Odessa PD — portal FAILED twice)');
    console.log('Expected: NOT SUBMIT_PORTAL (portal failed with navigation block)');
    console.log('='.repeat(70));

    const case42 = await db.getCaseById(42);
    const msgs42 = await db.getMessagesByCaseId(42, 10);
    const props42 = (await db.query(
        `SELECT action_type, status, reasoning FROM proposals WHERE case_id = 42 ORDER BY created_at DESC LIMIT 5`
    )).rows;

    console.log(`\nCase: ${case42.case_name}`);
    console.log(`Status: ${case42.status}`);
    console.log(`Portal URL: ${case42.portal_url || 'NONE'}`);
    console.log(`Messages: ${msgs42.length}`);
    console.log(`Prior proposals: ${props42.map(p => `${p.action_type}(${p.status})`).join(', ')}`);

    const lessons42 = await decisionMemory.getRelevantLessons(case42, { messages: msgs42, priorProposals: props42 });
    console.log(`\nRelevant lessons: ${lessons42.length}`);
    for (const l of lessons42) {
        console.log(`  [${l.category}] (priority ${l.priority}, relevance ${l.relevance_score}): ${l.lesson.substring(0, 100)}`);
    }

    console.log('\nRunning AI triage...');
    const result42 = await aiService.triageStuckCase(case42, msgs42, props42);
    console.log(`\nAI DECISION: ${result42.actionType} (confidence: ${result42.confidence})`);
    console.log(`Summary: ${result42.summary}`);
    console.log(`Recommendation: ${result42.recommendation}`);

    const pass4 = result42.actionType !== 'SUBMIT_PORTAL';
    console.log(`\n${pass4 ? '✅ PASS' : '❌ FAIL'}: AI ${pass4 ? 'avoided' : 'incorrectly proposed'} SUBMIT_PORTAL for failed-portal case`);

    // ===================================================================
    console.log('\n' + '='.repeat(70));
    console.log('TEST 5: Case #1658 (Anderson County — denial, ongoing investigation)');
    console.log('Expected: SEND_REBUTTAL citing segregable portions');
    console.log('='.repeat(70));

    const case1658 = await db.getCaseById(1658);
    const msgs1658 = await db.getMessagesByCaseId(1658, 10);
    const props1658 = (await db.query(
        `SELECT action_type, status, reasoning FROM proposals WHERE case_id = 1658 ORDER BY created_at DESC LIMIT 5`
    )).rows;

    console.log(`\nCase: ${case1658.case_name}`);
    console.log(`Status: ${case1658.status}`);
    console.log(`Portal URL: ${case1658.portal_url || 'NONE'}`);
    console.log(`Prior proposals: ${props1658.map(p => `${p.action_type}(${p.status})`).join(', ')}`);

    const lessons1658 = await decisionMemory.getRelevantLessons(case1658, { messages: msgs1658, priorProposals: props1658 });
    console.log(`\nRelevant lessons: ${lessons1658.length}`);
    for (const l of lessons1658) {
        console.log(`  [${l.category}] (priority ${l.priority}, relevance ${l.relevance_score}): ${l.lesson.substring(0, 100)}`);
    }

    console.log('\nRunning AI triage...');
    const result1658 = await aiService.triageStuckCase(case1658, msgs1658, props1658);
    console.log(`\nAI DECISION: ${result1658.actionType} (confidence: ${result1658.confidence})`);
    console.log(`Summary: ${result1658.summary}`);
    console.log(`Recommendation: ${result1658.recommendation}`);

    const pass5 = result1658.actionType === 'SEND_REBUTTAL' || result1658.actionType === 'CLOSE_CASE';
    console.log(`\n${pass5 ? '✅ PASS' : '❌ FAIL'}: AI proposed ${result1658.actionType} (expected SEND_REBUTTAL or CLOSE_CASE)`);

    // ===================================================================
    // Cleanup: remove the test-created lesson
    if (learnedId) {
        await decisionMemory.deleteLesson(learnedId);
        console.log(`\nCleaned up test lesson #${learnedId}`);
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    const results = [
        { test: 'Denial case → no SUBMIT_PORTAL', pass: pass1 },
        { test: 'Auto-lesson created on dismissal', pass: afterCount > beforeCount },
        { test: 'Round 2 references new lesson', pass: hasNewLesson },
        { test: 'Round 2 still avoids SUBMIT_PORTAL', pass: pass3 },
        { test: 'Failed portal → no SUBMIT_PORTAL', pass: pass4 },
        { test: 'Ongoing investigation → SEND_REBUTTAL', pass: pass5 }
    ];
    for (const r of results) {
        console.log(`  ${r.pass ? '✅' : '❌'} ${r.test}`);
    }
    const passCount = results.filter(r => r.pass).length;
    console.log(`\n${passCount}/${results.length} tests passed`);

    await db.close();
}

test().catch(e => { console.error(e); process.exit(1); });
