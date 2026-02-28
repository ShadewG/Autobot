const express = require('express');
const router = express.Router();
const { db } = require('./_helpers');

// =========================================================================
// E2E SCENARIO RUNNER
// =========================================================================

/**
 * E2E Scenario Templates
 * Each scenario includes:
 * - Inbound message configurations
 * - Expected classifications/outcomes
 * - Stubbed LLM responses for determinism
 */
const E2E_SCENARIOS = {
    fee_low_auto: {
        name: 'Fee Quote (Low) - Auto Approve',
        description: 'Low fee under threshold, should auto-approve in AUTO mode',
        phases: ['setup', 'inject_inbound', 'process', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Fee Quote',
            body: 'The estimated cost for your request is $15.00. Please confirm if you wish to proceed with payment.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'FEE_QUOTE',
            fee_amount: 15,
            action_type: 'ACCEPT_FEE',
            auto_execute: true,
            requires_human: false
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.95, sentiment: 'neutral', fee_amount: 15 },
            draft: { subject: 'Re: Fee Approval', body: 'I agree to pay the $15.00 fee. Please proceed with processing my request.' }
        }
    },
    fee_high_gate: {
        name: 'Fee Quote (High) - Human Gate',
        description: 'High fee requires human approval',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Fee Quote',
            body: 'The estimated cost for your request is $350.00 with a required $75 deposit. Note: Body-worn camera footage is exempt from disclosure under state law.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'SUPERVISED' },
        expected: {
            classification: 'FEE_QUOTE',
            fee_amount: 350,
            action_type: 'ACCEPT_FEE',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'FEE_QUOTE'
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.92, sentiment: 'neutral', fee_amount: 350, key_points: ['BWC exempt'] },
            draft: { subject: 'Re: Fee Approval', body: 'I agree to pay the $350.00 fee and the $75 deposit. Please proceed.' }
        }
    },
    denial_weak: {
        name: 'Denial (Weak) - Auto Rebuttal',
        description: 'Weak denial without strong exemption, auto-rebuttable',
        phases: ['setup', 'inject_inbound', 'process', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Denied',
            body: 'Your request has been denied. We do not have records matching your description.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'DENIAL',
            action_type: 'SEND_REBUTTAL',
            auto_execute: true
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.88, sentiment: 'neutral', key_points: ['no records found'] },
            draft: { subject: 'Re: Appeal of Denial', body: 'I am appealing this denial. Please conduct a more thorough search...' }
        }
    },
    denial_strong: {
        name: 'Denial (Strong) - Human Gate',
        description: 'Strong denial with exemption requires human review',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - DENIED',
            body: 'Your request is DENIED pursuant to Exemption 7(A) - records compiled for law enforcement purposes, disclosure would interfere with ongoing investigation. This matter involves sealed court proceedings.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'DENIAL',
            action_type: 'SEND_REBUTTAL',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'DENIAL'
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.95, sentiment: 'negative', key_points: ['exemption 7(A)', 'ongoing investigation', 'sealed'] },
            draft: { subject: 'Re: Appeal', body: 'I respectfully appeal this denial...' }
        }
    },
    clarification: {
        name: 'Clarification Request',
        description: 'Agency needs more information',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Additional Information Needed',
            body: 'We need additional information to process your request. Please provide the specific date range and incident report number if available.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'SUPERVISED' },
        expected: {
            classification: 'CLARIFICATION_REQUEST',
            action_type: 'SEND_CLARIFICATION',
            requires_human: true,
            pause_reason: 'SCOPE'
        },
        llm_stubs: {
            classify: { classification: 'CLARIFICATION_REQUEST', confidence: 0.90, sentiment: 'neutral' },
            draft: { subject: 'Re: Additional Information', body: 'The incident occurred on...' }
        }
    },
    hostile: {
        name: 'Hostile Response',
        description: 'Hostile sentiment triggers escalation',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'verify'],
        inbound: {
            subject: 'FINAL WARNING - DO NOT CONTACT AGAIN',
            body: 'This is your FINAL notice. Your frivolous and harassing requests are DENIED. Any further contact will be reported to law enforcement. DO NOT CONTACT THIS OFFICE AGAIN.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        expected: {
            classification: 'DENIAL',
            sentiment: 'hostile',
            action_type: 'ESCALATE',
            requires_human: true,
            pause_reason: 'SENSITIVE'
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.85, sentiment: 'hostile', key_points: ['final notice', 'harassment allegation'] }
        }
    },
    portal_case: {
        name: 'Portal Case - No Email',
        description: 'Portal case should never send email',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Portal Update',
            body: 'Your request status has been updated. Fee: $50.00',
            channel: 'PORTAL'
        },
        case_setup: {
            autopilot_mode: 'SUPERVISED',
            portal_url: 'https://test-portal.gov/request/123',
            portal_provider: 'TestPortal'
        },
        expected: {
            classification: 'FEE_QUOTE',
            action_type: 'ACCEPT_FEE',
            email_blocked: true  // Special assertion
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.90, sentiment: 'neutral', fee_amount: 50 }
        }
    },
    followup_no_response: {
        name: 'No Response - Follow-up',
        description: 'Time-based trigger for follow-up',
        phases: ['setup', 'trigger_followup', 'process', 'verify'],
        inbound: null,  // No inbound, time-triggered
        case_setup: { autopilot_mode: 'AUTO', status: 'awaiting_response' },
        expected: {
            classification: 'NO_RESPONSE',
            action_type: 'SEND_FOLLOWUP',
            auto_execute: true
        },
        llm_stubs: {
            draft: { subject: 'Follow-up: Records Request', body: 'I am following up on my records request submitted on...' }
        }
    },

    // ==================== HUMAN FLOW SCENARIOS ====================
    // These test the interrupt/resume patterns

    denial_strong_approve: {
        name: 'Denial (Strong) - Human Approves',
        description: 'Strong denial gates, human approves the rebuttal',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - DENIED',
            body: 'Your request is DENIED pursuant to Exemption 7(A) - law enforcement investigation.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        human_decision: { action: 'APPROVE' },  // Simulate human approving
        expected: {
            classification: 'DENIAL',
            action_type: 'SEND_REBUTTAL',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'DENIAL',
            // After human approval:
            final_proposal_status: 'EXECUTED',
            final_requires_human: false
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.95, sentiment: 'negative', key_points: ['exemption 7(A)', 'law enforcement'] },
            draft: { subject: 'Re: Appeal of Denial', body: 'I respectfully appeal this denial under the Freedom of Information Act...' }
        }
    },

    denial_strong_adjust: {
        name: 'Denial (Strong) - Human Adjusts',
        description: 'Strong denial gates, human requests adjustment, re-drafts',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'verify'],
        inbound: {
            subject: 'Re: Records Request - DENIED',
            body: 'Your request is DENIED pursuant to Exemption 7(A).',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        human_decision: { action: 'ADJUST', instruction: 'Make the appeal more assertive and cite relevant case law' },
        expected: {
            classification: 'DENIAL',
            action_type: 'SEND_REBUTTAL',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'DENIAL',
            // After adjustment: should re-gate with new draft
            final_requires_human: true  // Still needs approval after re-draft
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.95, sentiment: 'negative', key_points: ['exemption 7(A)'] },
            draft: { subject: 'Re: Appeal of Denial', body: 'I strongly contest this denial...' },
            // Re-draft after adjustment
            redraft: { subject: 'Re: Appeal of Denial (Revised)', body: 'I emphatically appeal this denial citing FOIA case law...' }
        }
    },

    denial_strong_dismiss: {
        name: 'Denial (Strong) - Human Dismisses',
        description: 'Strong denial gates, human dismisses proposal (no action)',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'verify'],
        inbound: {
            subject: 'Re: Records Request - DENIED',
            body: 'Your request is DENIED pursuant to Exemption 7(A).',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'AUTO' },
        human_decision: { action: 'DISMISS' },
        expected: {
            classification: 'DENIAL',
            action_type: 'SEND_REBUTTAL',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'DENIAL',
            // After dismiss: no execution, proposal abandoned
            final_proposal_status: 'DISMISSED',
            final_requires_human: false
        },
        llm_stubs: {
            classify: { classification: 'DENIAL', confidence: 0.95, sentiment: 'negative', key_points: ['exemption 7(A)'] },
            draft: { subject: 'Re: Appeal', body: 'Appeal draft...' }
        }
    },

    fee_high_approve: {
        name: 'Fee Quote (High) - Human Approves',
        description: 'High fee gates, human approves payment',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Fee Quote',
            body: 'The estimated cost for your request is $450.00.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'SUPERVISED' },
        human_decision: { action: 'APPROVE' },
        expected: {
            classification: 'FEE_QUOTE',
            fee_amount: 450,
            action_type: 'ACCEPT_FEE',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'FEE_QUOTE',
            // After approval:
            final_proposal_status: 'EXECUTED',
            final_requires_human: false
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.92, sentiment: 'neutral', fee_amount: 450 },
            draft: { subject: 'Re: Fee Approval', body: 'I agree to pay the $450.00 fee. Please proceed.' }
        }
    },

    fee_high_withdraw: {
        name: 'Fee Quote (High) - Human Withdraws',
        description: 'High fee gates, human withdraws request',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'verify'],
        inbound: {
            subject: 'Re: Records Request - Fee Quote',
            body: 'The estimated cost for your request is $2,500.00.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'SUPERVISED' },
        human_decision: { action: 'WITHDRAW' },
        expected: {
            classification: 'FEE_QUOTE',
            fee_amount: 2500,
            action_type: 'NEGOTIATE_FEE',  // High fee triggers negotiate
            auto_execute: false,
            requires_human: true,
            pause_reason: 'FEE_QUOTE',
            // After withdraw:
            final_case_status: 'cancelled',
            final_requires_human: false
        },
        llm_stubs: {
            classify: { classification: 'FEE_QUOTE', confidence: 0.90, sentiment: 'neutral', fee_amount: 2500 },
            draft: { subject: 'Re: Fee Negotiation', body: 'I would like to negotiate the fee...' }
        }
    },

    clarification_supervised_approve: {
        name: 'Clarification - Human Approves',
        description: 'Clarification request in supervised mode, human approves response',
        phases: ['setup', 'inject_inbound', 'process', 'human_gate', 'execute', 'verify'],
        inbound: {
            subject: 'Re: Records Request - More Info Needed',
            body: 'Please provide the specific incident date and case number.',
            channel: 'EMAIL'
        },
        case_setup: { autopilot_mode: 'SUPERVISED' },
        human_decision: { action: 'APPROVE' },
        expected: {
            classification: 'CLARIFICATION_REQUEST',
            action_type: 'SEND_CLARIFICATION',
            auto_execute: false,
            requires_human: true,
            pause_reason: 'SCOPE',
            // After approval:
            final_proposal_status: 'EXECUTED',
            final_requires_human: false
        },
        llm_stubs: {
            classify: { classification: 'CLARIFICATION_REQUEST', confidence: 0.92, sentiment: 'neutral' },
            draft: { subject: 'Re: Additional Information', body: 'The incident occurred on January 15, 2024. The case number is 24-12345.' }
        }
    }
};

/**
 * Active E2E runs storage (in-memory for dev, would be Redis in prod)
 */
const activeE2ERuns = new Map();

/**
 * Create a new E2E run
 *
 * IMPORTANT: Scenario config and expectations are persisted at creation time.
 * All execution reads from run.scenario, never from E2E_SCENARIOS.
 */
function createE2ERun(caseId, scenarioKey, options = {}) {
    const runId = `e2e_${caseId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const scenarioTemplate = E2E_SCENARIOS[scenarioKey];

    if (!scenarioTemplate) {
        throw new Error(`Unknown scenario: ${scenarioKey}`);
    }

    // Generate per-run thread_id to isolate test runs
    const threadId = `case:${caseId}:e2e:${runId}`;

    // Deep-copy scenario config to persist in run (immutable snapshot)
    const scenario = JSON.parse(JSON.stringify({
        key: scenarioKey,
        name: scenarioTemplate.name,
        description: scenarioTemplate.description,
        phases: scenarioTemplate.phases,
        inbound: scenarioTemplate.inbound,
        case_setup: scenarioTemplate.case_setup,
        expected: scenarioTemplate.expected,
        llm_stubs: scenarioTemplate.llm_stubs
    }));

    const run = {
        id: runId,
        case_id: caseId,
        // Store full scenario config - execution reads from here, not E2E_SCENARIOS
        scenario,
        // Convenience aliases (read from scenario)
        scenario_key: scenario.key,
        scenario_name: scenario.name,
        phases: scenario.phases,
        current_phase_index: 0,
        current_phase: scenario.phases[0],
        status: 'initialized',
        use_worker: options.use_worker !== false,
        dry_run: options.dry_run !== false,
        deterministic: options.deterministic !== false,
        created_at: new Date().toISOString(),
        state_snapshots: [],
        artifacts: {
            inbound_message_id: null,
            proposal_id: null,
            proposal_key: null,
            job_ids: [],
            thread_id: threadId  // Per-run thread_id for isolation
        },
        // Decision trace - populated during execution
        decision_trace: {
            classification: null,
            router_output: null,
            node_trace: [],
            gate_decision: null
        },
        logs: [`Run created for scenario: ${scenario.name}`, `Thread ID: ${threadId}`],
        assertions: [],
        human_decision: null
    };

    activeE2ERuns.set(runId, run);
    return run;
}

/**
 * Capture state snapshot for a run
 */
async function captureStateSnapshot(run, label) {
    const caseData = await db.getCaseById(run.case_id);
    const proposals = await db.query(
        'SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 5',
        [run.case_id]
    );

    const snapshot = {
        label,
        timestamp: new Date().toISOString(),
        case: {
            status: caseData?.status,
            requires_human: caseData?.requires_human,
            pause_reason: caseData?.pause_reason,
            langgraph_thread_id: caseData?.langgraph_thread_id,
            autopilot_mode: caseData?.autopilot_mode
        },
        proposals: proposals.rows.map(p => ({
            id: p.id,
            proposal_key: p.proposal_key,
            action_type: p.action_type,
            status: p.status,
            execution_key: p.execution_key,
            human_decision: p.human_decision
        })),
        artifacts: { ...run.artifacts }
    };

    run.state_snapshots.push(snapshot);
    return snapshot;
}

/**
 * Capture decision trace from latest analysis and proposal
 * Shows: classification → router decision → action type → gate decision
 */
async function captureDecisionTrace(run) {
    try {
        // Get latest response analysis for this run's inbound message
        let analysis = null;
        if (run.artifacts.inbound_message_id) {
            analysis = await db.getAnalysisByMessageId(run.artifacts.inbound_message_id);
        }

        // Get latest proposal for this case
        const proposalResult = await db.query(
            `SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [run.case_id]
        );
        const proposal = proposalResult.rows[0];

        // Get case state
        const caseData = await db.getCaseById(run.case_id);

        // Build decision trace
        run.decision_trace = {
            classification: analysis ? {
                intent: analysis.intent,
                confidence: analysis.confidence_score,
                sentiment: analysis.sentiment,
                fee_amount: analysis.extracted_fee_amount,
                key_points: analysis.key_points
            } : null,
            router_output: proposal ? {
                action_type: proposal.action_type,
                can_auto_execute: proposal.can_auto_execute,
                status: proposal.status
            } : null,
            node_trace: [
                'load_context',
                'classify_inbound',
                'update_constraints',
                'decide_next_action',
                ...(proposal ? ['draft_response', 'safety_check', 'gate_or_execute'] : []),
                ...(proposal?.status === 'EXECUTED' ? ['execute_action', 'commit_state'] : [])
            ],
            gate_decision: caseData?.requires_human ? {
                gated: true,
                pause_reason: caseData.pause_reason,
                proposal_id: proposal?.id,
                proposal_status: proposal?.status
            } : {
                gated: false,
                auto_executed: proposal?.status === 'EXECUTED'
            }
        };

        run.logs.push(`Decision trace captured: ${run.decision_trace.router_output?.action_type || 'N/A'}`);
    } catch (error) {
        run.logs.push(`Failed to capture decision trace: ${error.message}`);
    }
}

/**
 * Execute a single phase of an E2E run
 *
 * IMPORTANT: All config is read from run.scenario (persisted at creation),
 * NEVER from E2E_SCENARIOS. This ensures test isolation and reproducibility.
 */
async function executePhase(run) {
    // Read scenario from persisted run config, NOT from E2E_SCENARIOS
    const scenario = run.scenario;
    const phase = run.current_phase;

    run.logs.push(`Executing phase: ${phase}`);

    try {
        switch (phase) {
            case 'setup': {
                // Use per-run thread_id for isolation (already set at creation)
                const langgraphThreadId = run.artifacts.thread_id;

                // Apply case setup AND set langgraph_thread_id in the same update
                const caseUpdate = {
                    ...(scenario.case_setup || {}),
                    langgraph_thread_id: langgraphThreadId
                };
                await db.updateCase(run.case_id, caseUpdate);
                run.logs.push(`Applied case setup: ${JSON.stringify(caseUpdate)}`);

                await captureStateSnapshot(run, 'after_setup');
                break;
            }

            case 'inject_inbound': {
                if (!scenario.inbound) {
                    run.logs.push('No inbound to inject (time-triggered scenario)');
                    break;
                }

                // Create inbound message tagged with run_id
                const thread = await ensureEmailThread(run.case_id);
                const message = await createInboundMessage(run.case_id, thread.id, {
                    subject: scenario.inbound.subject,
                    body: scenario.inbound.body,
                    channel: scenario.inbound.channel || 'EMAIL'
                });

                run.artifacts.inbound_message_id = message.id;
                run.logs.push(`Injected inbound message: ${message.id}`);
                await captureStateSnapshot(run, 'after_inject');
                break;
            }

            case 'trigger_followup': {
                // For no-response scenarios, just update case to trigger followup
                await db.updateCase(run.case_id, { status: 'awaiting_response' });
                run.logs.push('Triggered followup scenario');
                await captureStateSnapshot(run, 'after_trigger');
                break;
            }

            case 'process': {
                // Invoke the graph (via worker or direct)
                const triggerType = scenario.inbound ? 'agency_reply' : 'time_based_followup';

                // Pass llm_stubs from persisted scenario config, thread_id for isolation
                const invokeOptions = {
                    e2e_run_id: run.id,
                    messageId: run.artifacts.inbound_message_id,
                    llmStubs: run.deterministic ? scenario.llm_stubs : null,
                    threadId: run.artifacts.thread_id  // Per-run thread for isolation
                };

                const { tasks: triggerTasks } = require('@trigger.dev/sdk/v3');
                const taskId = run.artifacts.inbound_message_id ? 'process-inbound' : 'process-followup';
                const taskPayload = run.artifacts.inbound_message_id
                    ? { caseId: run.case_id, messageId: run.artifacts.inbound_message_id, autopilotMode: 'on' }
                    : { caseId: run.case_id };
                const handle = await triggerTasks.trigger(taskId, taskPayload);
                run.artifacts.trigger_run_id = handle.id;
                run.logs.push(`Triggered Trigger.dev task: ${taskId} (run: ${handle.id})`);

                const result = await waitForAgentRun(run.case_id, 60000);
                run.logs.push(`Agent run completed: ${result.status}`);

                // Capture decision trace from latest analysis
                await captureDecisionTrace(run);

                await captureStateSnapshot(run, 'after_process');

                // Check if we hit an interrupt
                const caseAfter = await db.getCaseById(run.case_id);
                if (caseAfter.requires_human) {
                    run.status = 'awaiting_human';
                    run.logs.push('Hit human gate - awaiting decision');

                    // CRITICAL: Advance to human_gate phase so we don't re-run process
                    const humanGateIndex = run.phases.indexOf('human_gate');
                    if (humanGateIndex > run.current_phase_index) {
                        run.current_phase_index = humanGateIndex;
                        run.current_phase = 'human_gate';
                        run.logs.push('Advanced to human_gate phase');
                    }
                }
                break;
            }

            case 'human_gate': {
                // Auto-apply scenario's human_decision if present and no manual decision set
                if (!run.human_decision && scenario.human_decision) {
                    run.human_decision = scenario.human_decision;
                    run.logs.push(`Auto-applied scenario human_decision: ${scenario.human_decision.action}`);
                }

                // This phase waits for human input
                if (!run.human_decision) {
                    run.status = 'awaiting_human';
                    run.logs.push('Waiting for human decision');
                    return { needs_human: true };
                }

                // Process the human decision
                const decision = run.human_decision;
                run.logs.push(`Processing human decision: ${decision.action}`);

                // Send decision via the run-engine decision endpoint (completes Trigger.dev waitpoint)
                const pendingProposal = await db.query(
                    `SELECT id, waitpoint_token FROM proposals WHERE case_id = $1 AND status = 'PENDING_APPROVAL' ORDER BY created_at DESC LIMIT 1`,
                    [run.case_id]
                );
                if (pendingProposal.rows.length > 0) {
                    const proposal = pendingProposal.rows[0];
                    if (proposal.waitpoint_token) {
                        const { wait: triggerWait } = require('@trigger.dev/sdk/v3');
                        await triggerWait.completeToken(proposal.waitpoint_token, decision);
                        run.logs.push(`Completed waitpoint for proposal ${proposal.id}: ${decision.action}`);
                    }
                    const result = await waitForAgentRun(run.case_id, 60000);
                    run.logs.push(`Agent run completed after human decision: ${result.status}`);
                } else {
                    run.logs.push(`No pending proposal found for human decision`);
                }

                run.human_decision = null;
                await captureStateSnapshot(run, 'after_human_gate');
                break;
            }

            case 'execute': {
                // Execution happens as part of process/human_gate
                // This phase just verifies execution occurred
                await captureStateSnapshot(run, 'after_execute');
                break;
            }

            case 'verify': {
                // Run assertions
                run.assertions = await runE2EAssertions(run);
                await captureStateSnapshot(run, 'final');
                run.status = 'completed';
                run.logs.push('Verification complete');
                break;
            }

            default:
                run.logs.push(`Unknown phase: ${phase}`);
        }

        return { success: true };
    } catch (error) {
        run.logs.push(`Phase error: ${error.message}`);
        run.status = 'error';
        return { success: false, error: error.message };
    }
}

/**
 * Wait for the most recent agent run for a case to reach a terminal state.
 * Polls the agent_runs table since Trigger.dev tasks run in the cloud.
 */
async function waitForAgentRun(caseId, timeoutMs = 60000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const result = await db.query(
            `SELECT status FROM agent_runs WHERE case_id = $1 ORDER BY started_at DESC LIMIT 1`,
            [caseId]
        );
        const status = result.rows[0]?.status;
        if (status === 'completed' || status === 'failed') {
            return { status };
        }
        if (status === 'waiting') {
            // Task is waiting for human input — treat as interrupt
            return { status: 'interrupted' };
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    return { status: 'timeout' };
}

/**
 * Ensure email thread exists for case
 */
async function ensureEmailThread(caseId) {
    const caseData = await db.getCaseById(caseId);
    let thread = await db.getThreadByCaseId(caseId);

    if (!thread) {
        thread = await db.createEmailThread({
            case_id: caseId,
            thread_id: `e2e-thread-${caseId}-${Date.now()}`,
            subject: `Records Request - Case ${caseId}`,
            agency_email: caseData.agency_email || 'test@agency.gov',
            initial_message_id: `initial-${Date.now()}@test.local`,
            status: 'active'
        });
    }

    return thread;
}

/**
 * Create an inbound message for testing
 */
async function createInboundMessage(caseId, threadId, config) {
    const messageId = `inbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;

    // Use db.createMessage which inserts into the correct 'messages' table
    const message = await db.createMessage({
        thread_id: threadId,
        case_id: caseId,
        message_id: messageId,
        sendgrid_message_id: null,
        direction: 'inbound',
        from_email: 'records@agency.gov',
        to_email: 'user@example.com',
        cc_emails: null,
        subject: config.subject,
        body_text: config.body,
        body_html: `<p>${config.body}</p>`,
        has_attachments: false,
        attachment_count: 0,
        message_type: config.channel === 'PORTAL' ? 'portal_notification' : 'email',
        portal_notification: config.channel === 'PORTAL',
        portal_notification_type: config.channel === 'PORTAL' ? 'status_update' : null,
        portal_notification_provider: null,
        sent_at: null,
        received_at: new Date()
    });

    // Update case status (note: cases table doesn't have latest_inbound_message_id)
    await db.updateCase(caseId, {
        status: 'needs_review',
        last_response_date: new Date()
    });

    // Update email thread with latest message info
    await db.updateThread(threadId, {
        last_message_at: new Date()
    });

    return message;
}

/**
 * Run E2E assertions for a run
 *
 * IMPORTANT: Expectations are read from run.scenario.expected (persisted at creation),
 * NEVER from E2E_SCENARIOS. This ensures test reproducibility.
 */
async function runE2EAssertions(run) {
    // Read expected values from persisted scenario config, NOT from E2E_SCENARIOS
    const expected = run.scenario.expected;
    const assertions = [];

    // Verify scenario is properly loaded (hard fail on mismatch)
    if (!expected) {
        assertions.push({
            name: 'scenario_loaded',
            passed: false,
            expected: 'run.scenario.expected to exist',
            actual: 'undefined'
        });
        return assertions;
    }

    const caseData = await db.getCaseById(run.case_id);
    const proposals = await db.query(
        'SELECT * FROM proposals WHERE case_id = $1 ORDER BY created_at DESC',
        [run.case_id]
    );
    const latestProposal = proposals.rows[0];
    const pendingProposals = proposals.rows.filter(p => p.status === 'PENDING_APPROVAL');

    // A1: Action type matches expected
    if (expected.action_type) {
        assertions.push({
            name: 'action_type_matches',
            passed: latestProposal?.action_type === expected.action_type,
            expected: expected.action_type,
            actual: latestProposal?.action_type
        });
    }

    // A2: Proposal has non-null action_type
    assertions.push({
        name: 'action_type_not_null',
        passed: latestProposal?.action_type != null,
        expected: 'non-null',
        actual: latestProposal?.action_type
    });

    // A3: Proposal key is stable (unique)
    const keyCount = proposals.rows.filter(p => p.proposal_key === latestProposal?.proposal_key).length;
    assertions.push({
        name: 'proposal_key_stable',
        passed: keyCount === 1,
        expected: '1 proposal per key',
        actual: `${keyCount} proposals with key`
    });

    // A4: requires_human matches expected
    if (expected.requires_human !== undefined) {
        assertions.push({
            name: 'requires_human_matches',
            passed: caseData.requires_human === expected.requires_human,
            expected: expected.requires_human,
            actual: caseData.requires_human
        });
    }

    // A5: pause_reason matches expected
    if (expected.pause_reason) {
        assertions.push({
            name: 'pause_reason_matches',
            passed: caseData.pause_reason === expected.pause_reason,
            expected: expected.pause_reason,
            actual: caseData.pause_reason
        });
    }

    // === INVARIANT ASSERTIONS (always checked) ===

    // INV1: requires_human ⇒ pause_reason must exist
    if (caseData.requires_human) {
        assertions.push({
            name: 'invariant_requires_human_has_reason',
            passed: caseData.pause_reason != null,
            expected: 'pause_reason when requires_human=true',
            actual: caseData.pause_reason || 'null'
        });
    }

    // INV2: requires_human ⇒ exactly 1 pending proposal
    if (caseData.requires_human) {
        assertions.push({
            name: 'invariant_requires_human_one_pending',
            passed: pendingProposals.length === 1,
            expected: 'exactly 1 pending proposal when requires_human=true',
            actual: `${pendingProposals.length} pending proposals`
        });
    }

    // INV3: pending approval ⇒ execution_key must be null
    for (const pending of pendingProposals) {
        if (pending.execution_key != null) {
            assertions.push({
                name: 'invariant_pending_no_execution_key',
                passed: false,
                expected: 'execution_key=null for PENDING_APPROVAL',
                actual: `proposal ${pending.id} has execution_key=${pending.execution_key}`
            });
        }
    }
    // If all pending proposals are valid, add a pass
    if (pendingProposals.length > 0 && pendingProposals.every(p => p.execution_key == null)) {
        assertions.push({
            name: 'invariant_pending_no_execution_key',
            passed: true,
            expected: 'execution_key=null for PENDING_APPROVAL',
            actual: 'all pending proposals valid'
        });
    }

    // A7: Exactly-once execution check
    const executedProposals = proposals.rows.filter(p => p.status === 'EXECUTED');
    const executionKeys = executedProposals.map(p => p.execution_key).filter(Boolean);
    const uniqueExecutionKeys = new Set(executionKeys);
    assertions.push({
        name: 'exactly_once_execution',
        passed: executionKeys.length === uniqueExecutionKeys.size,
        expected: 'unique execution keys',
        actual: `${executionKeys.length} executions, ${uniqueExecutionKeys.size} unique keys`
    });

    // A8: Portal case should not send email
    if (expected.email_blocked && caseData.portal_url) {
        const emailSends = executedProposals.filter(p =>
            p.action_type?.startsWith('SEND_') && !p.execution_result?.dry_run
        );
        assertions.push({
            name: 'portal_no_email_send',
            passed: emailSends.length === 0,
            expected: 'no email sends for portal case',
            actual: `${emailSends.length} email sends`
        });
    }

    // === HUMAN FLOW ASSERTIONS (for scenarios with human_decision) ===

    // HF1: Final proposal status after human action
    if (expected.final_proposal_status) {
        assertions.push({
            name: 'final_proposal_status',
            passed: latestProposal?.status === expected.final_proposal_status,
            expected: expected.final_proposal_status,
            actual: latestProposal?.status || 'no proposal'
        });
    }

    // HF2: Final requires_human state after human action
    if (expected.final_requires_human !== undefined) {
        assertions.push({
            name: 'final_requires_human',
            passed: caseData.requires_human === expected.final_requires_human,
            expected: expected.final_requires_human,
            actual: caseData.requires_human
        });
    }

    // HF3: Final case status after human action (e.g., WITHDRAW → cancelled)
    if (expected.final_case_status) {
        assertions.push({
            name: 'final_case_status',
            passed: caseData.status === expected.final_case_status,
            expected: expected.final_case_status,
            actual: caseData.status
        });
    }

    // HF4: Proposal key stability - same proposal_key across resume/retries
    if (latestProposal?.proposal_key) {
        const proposalsWithSameKey = proposals.rows.filter(
            p => p.proposal_key === latestProposal.proposal_key
        );
        assertions.push({
            name: 'proposal_key_stable',
            passed: proposalsWithSameKey.length === 1,
            expected: 'exactly 1 proposal with this key (no duplicates)',
            actual: `${proposalsWithSameKey.length} proposals with key ${latestProposal.proposal_key}`
        });
    }

    // HF5: Executed proposals have unique execution_key
    if (executedProposals.length > 0) {
        const allHaveExecutionKey = executedProposals.every(p => p.execution_key != null);
        assertions.push({
            name: 'executed_has_execution_key',
            passed: allHaveExecutionKey,
            expected: 'all EXECUTED proposals have execution_key',
            actual: allHaveExecutionKey ? 'all have keys' : 'some missing execution_key'
        });
    }

    return assertions;
}

// =========================================================================
// ROUTES
// =========================================================================

/**
 * POST /api/test/e2e/runs
 * Create a new E2E test run
 */
router.post('/e2e/runs', async (req, res) => {
    try {
        const { case_id, scenario, use_worker = true, dry_run = true, deterministic = true } = req.body;

        if (!case_id) {
            return res.status(400).json({ success: false, error: 'case_id is required' });
        }

        if (!scenario || !E2E_SCENARIOS[scenario]) {
            return res.status(400).json({
                success: false,
                error: `Invalid scenario: ${scenario}`,
                available: Object.keys(E2E_SCENARIOS).map(k => ({
                    key: k,
                    name: E2E_SCENARIOS[k].name,
                    description: E2E_SCENARIOS[k].description
                }))
            });
        }

        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return res.status(404).json({ success: false, error: 'Case not found' });
        }

        const run = createE2ERun(case_id, scenario, { use_worker, dry_run, deterministic });

        // Store deterministic mode flag for LLM stubs (read from persisted scenario)
        if (deterministic) {
            global.__E2E_DETERMINISTIC_RUN__ = run.id;
            global.__E2E_LLM_STUBS__ = run.scenario.llm_stubs;  // Read from run, not E2E_SCENARIOS
        }

        res.json({
            success: true,
            run
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/test/e2e/runs/:runId
 * Get E2E run status
 */
router.get('/e2e/runs/:runId', (req, res) => {
    const run = activeE2ERuns.get(req.params.runId);
    if (!run) {
        return res.status(404).json({ success: false, error: 'Run not found' });
    }
    res.json({ success: true, run });
});

/**
 * GET /api/test/e2e/scenarios
 * List available scenarios
 */
router.get('/e2e/scenarios', (req, res) => {
    const scenarios = Object.entries(E2E_SCENARIOS).map(([key, s]) => ({
        key,
        name: s.name,
        description: s.description,
        phases: s.phases,
        expected: s.expected
    }));
    res.json({ success: true, scenarios });
});

/**
 * POST /api/test/e2e/runs/:runId/reset
 * Reset a run to start fresh
 *
 * IMPORTANT: Reset does NOT allow changing scenarios.
 * To run a different scenario, create a new run.
 * This ensures scenario config integrity.
 */
router.post('/e2e/runs/:runId/reset', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        // Don't allow changing scenario on reset - create new run instead
        const { scenario: requestedScenario } = req.body;
        if (requestedScenario && requestedScenario !== run.scenario_key) {
            return res.status(400).json({
                success: false,
                error: 'Cannot change scenario on reset. Create a new run for a different scenario.',
                current_scenario: run.scenario_key,
                requested_scenario: requestedScenario
            });
        }

        // Note: Trigger.dev runs are managed in the cloud; no local job cancellation needed.
        run.artifacts.job_ids = [];

        // Reset the case state
        await db.updateCase(run.case_id, {
            status: 'ready_to_send',
            requires_human: false,
            pause_reason: null,
            langgraph_thread_id: null
        });

        // Clear proposals tagged with this run's thread_id
        const threadId = run.artifacts.thread_id;
        if (threadId) {
            await db.query('DELETE FROM proposals WHERE langgraph_thread_id = $1', [threadId]);
        }
        // Also clear all proposals for this case as fallback
        await db.query('DELETE FROM proposals WHERE case_id = $1', [run.case_id]);

        // Clear test messages created by this run
        if (run.artifacts.inbound_message_id) {
            await db.query('DELETE FROM messages WHERE id = $1', [run.artifacts.inbound_message_id]);
        }

        // Reset run state but preserve thread_id for isolation
        run.current_phase_index = 0;
        run.current_phase = run.scenario.phases[0];
        run.status = 'initialized';
        run.state_snapshots = [];
        run.artifacts = {
            inbound_message_id: null,
            proposal_id: null,
            proposal_key: null,
            job_ids: [],
            thread_id: threadId  // Keep the per-run thread_id
        };
        // Reset decision trace
        run.decision_trace = {
            classification: null,
            router_output: null,
            node_trace: [],
            gate_decision: null
        };
        run.logs = [...run.logs, `Run reset at ${new Date().toISOString()}`];
        run.assertions = [];
        run.human_decision = null;

        res.json({ success: true, run });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/runs/:runId/step
 * Execute one phase of the E2E run
 */
router.post('/e2e/runs/:runId/step', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        if (run.status === 'completed') {
            return res.json({ success: true, message: 'Run already completed', run });
        }

        if (run.status === 'error') {
            return res.json({ success: false, message: 'Run in error state', run });
        }

        const result = await executePhase(run);

        if (result.needs_human) {
            return res.json({
                success: true,
                needs_human: true,
                phase: run.current_phase,
                run
            });
        }

        // Advance to next phase if not waiting for human
        if (run.status !== 'awaiting_human' && run.status !== 'error' && run.status !== 'completed') {
            run.current_phase_index++;
            if (run.current_phase_index < run.phases.length) {
                run.current_phase = run.phases[run.current_phase_index];
                run.status = 'running';
            } else {
                run.status = 'completed';
            }
        }

        res.json({ success: true, result, run });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/runs/:runId/run-until-interrupt
 * Run phases until hitting a human gate or completion
 */
router.post('/e2e/runs/:runId/run-until-interrupt', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const maxIterations = 20;
        let iterations = 0;

        while (iterations < maxIterations) {
            iterations++;

            if (run.status === 'completed' || run.status === 'error') {
                break;
            }

            if (run.status === 'awaiting_human') {
                break;
            }

            const result = await executePhase(run);

            if (result.needs_human) {
                break;
            }

            // Advance to next phase
            if (run.status !== 'awaiting_human' && run.status !== 'error') {
                run.current_phase_index++;
                if (run.current_phase_index < run.phases.length) {
                    run.current_phase = run.phases[run.current_phase_index];
                    run.status = 'running';
                } else {
                    run.status = 'completed';
                    break;
                }
            }
        }

        res.json({
            success: true,
            iterations,
            run
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/runs/:runId/run-to-completion
 * Run all phases, auto-approving at human gates
 */
router.post('/e2e/runs/:runId/run-to-completion', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const { auto_decision = 'APPROVE' } = req.body;
        const maxIterations = 30;
        let iterations = 0;

        while (iterations < maxIterations && run.status !== 'completed' && run.status !== 'error') {
            iterations++;

            if (run.status === 'awaiting_human') {
                run.human_decision = { action: auto_decision };
                run.logs.push(`Auto-decision: ${auto_decision}`);
                run.status = 'running';
            }

            const result = await executePhase(run);

            // Advance to next phase
            if (run.status !== 'awaiting_human' && run.status !== 'error') {
                run.current_phase_index++;
                if (run.current_phase_index < run.phases.length) {
                    run.current_phase = run.phases[run.current_phase_index];
                } else {
                    run.status = 'completed';
                }
            }
        }

        res.json({
            success: true,
            iterations,
            run
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/runs/:runId/human-decision
 * Submit a human decision for an interrupted run
 */
router.post('/e2e/runs/:runId/human-decision', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const { action, instruction } = req.body;

        if (!['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid action',
                valid: ['APPROVE', 'ADJUST', 'DISMISS', 'WITHDRAW']
            });
        }

        run.human_decision = { action, instruction };
        run.status = 'running';
        run.logs.push(`Human decision received: ${action}${instruction ? ` (${instruction})` : ''}`);

        res.json({ success: true, run });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/test/e2e/inject-inbound
 * Inject an inbound message (standalone endpoint)
 */
router.post('/e2e/inject-inbound', async (req, res) => {
    try {
        const { case_id, subject, body, channel = 'EMAIL' } = req.body;

        if (!case_id || !subject || !body) {
            return res.status(400).json({
                success: false,
                error: 'case_id, subject, and body are required'
            });
        }

        const thread = await ensureEmailThread(case_id);
        const message = await createInboundMessage(case_id, thread.id, { subject, body, channel });

        res.json({
            success: true,
            message_id: message.id,
            thread_id: thread.id,
            message
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/test/e2e/inbound-presets
 * Get inbound message presets
 */
router.get('/e2e/inbound-presets', (req, res) => {
    const presets = {
        ack: {
            name: 'Acknowledgment',
            subject: 'Re: Records Request Received',
            body: 'Your records request has been received and assigned tracking number RR-2024-1234. We will respond within 10 business days.'
        },
        fee_low: {
            name: 'Fee Quote (Low)',
            subject: 'Re: Records Request - Fee Estimate',
            body: 'The estimated cost for your request is $15.00. Please confirm if you wish to proceed with payment.'
        },
        fee_high: {
            name: 'Fee Quote (High)',
            subject: 'Re: Records Request - Fee Estimate',
            body: 'The estimated cost for your request is $350.00 with a required $75.00 deposit. Note: Body-worn camera footage is exempt from disclosure under state law due to ongoing investigation.'
        },
        denial_exemption: {
            name: 'Denial with Exemption',
            subject: 'Re: Records Request - DENIED',
            body: 'Your request is DENIED pursuant to Exemption 7(A) - records compiled for law enforcement purposes. Disclosure would interfere with an ongoing criminal investigation.'
        },
        clarification: {
            name: 'Clarification Needed',
            subject: 'Re: Records Request - Additional Information Needed',
            body: 'We need additional information to process your request. Please provide: 1) Specific date range of incident 2) Incident report number if known 3) Names of officers involved'
        },
        portal_update: {
            name: 'Portal Instructions',
            subject: 'Portal Access Information',
            body: 'Your request has been transferred to our online portal. Please visit https://records.agency.gov/request/12345 to view status and download documents when available.'
        },
        hostile: {
            name: 'Hostile Response',
            subject: 'FINAL WARNING - CEASE AND DESIST',
            body: 'This is your FINAL notice regarding your frivolous and harassing records requests. Your request is DENIED. Any further communication will be forwarded to our legal department and reported as harassment. DO NOT CONTACT THIS OFFICE AGAIN.'
        },
        partial: {
            name: 'Partial Production',
            subject: 'Re: Records Request - Partial Response',
            body: 'We are providing a partial response to your request. Attached are the incident reports (15 pages). Note: Video footage is exempt from disclosure. Audio recordings are still being reviewed.'
        }
    };

    res.json({ success: true, presets });
});

/**
 * GET /api/test/e2e/runs/:runId/proposal
 * Get the current proposal for human gate display
 */
router.get('/e2e/runs/:runId/proposal', async (req, res) => {
    try {
        const run = activeE2ERuns.get(req.params.runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'Run not found' });
        }

        const proposals = await db.query(
            `SELECT * FROM proposals WHERE case_id = $1 AND status = 'PENDING_APPROVAL' ORDER BY created_at DESC LIMIT 1`,
            [run.case_id]
        );

        const proposal = proposals.rows[0];
        if (!proposal) {
            return res.json({ success: true, proposal: null, message: 'No pending proposal' });
        }

        res.json({
            success: true,
            proposal: {
                id: proposal.id,
                proposal_key: proposal.proposal_key,
                action_type: proposal.action_type,
                status: proposal.status,
                draft_subject: proposal.draft_subject,
                draft_body_text: proposal.draft_body_text,
                reasoning: proposal.reasoning,
                risk_flags: proposal.risk_flags,
                warnings: proposal.warnings,
                created_at: proposal.created_at
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/test/e2e/runs/:runId
 * Delete an E2E run
 */
router.delete('/e2e/runs/:runId', (req, res) => {
    const deleted = activeE2ERuns.delete(req.params.runId);
    res.json({ success: true, deleted });
});

/**
 * GET /api/test/e2e/runs
 * List all active E2E runs
 */
router.get('/e2e/runs', (req, res) => {
    const runs = Array.from(activeE2ERuns.values()).map(r => ({
        id: r.id,
        case_id: r.case_id,
        scenario_key: r.scenario_key,
        scenario_name: r.scenario_name,
        status: r.status,
        current_phase: r.current_phase,
        created_at: r.created_at
    }));
    res.json({ success: true, runs });
});

module.exports = router;
