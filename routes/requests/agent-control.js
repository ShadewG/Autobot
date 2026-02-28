const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db, logger, triggerDispatch } = require('./_helpers');

// =========================================================================
// Agent Run Listing
// =========================================================================

/**
 * GET /api/requests/:id/agent-runs
 * Get agent runs for a case with proposal details
 */
router.get('/:id/agent-runs', async (req, res) => {
    try {
        const requestId = parseInt(req.params.id);
        const limit = parseInt(req.query.limit) || 20;

        // Verify case exists
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get agent runs with proposal details
        const runs = await db.getAgentRunsByCaseId(requestId, limit);

        // Transform runs for API response
        const transformedRuns = runs.map(run => {
            // Preserve queue/waiting states for live status UI.
            const statusMap = { paused: 'waiting' };
            const displayStatus = statusMap[run.status] || run.status;
            const md = run.metadata || {};
            const nodeTraceFromMetadata = Array.isArray(run.metadata?.node_trace)
                ? run.metadata.node_trace
                : (typeof run.metadata?.current_node === 'string' ? [run.metadata.current_node] : []);
            const skyvernTaskUrl =
                md.skyvern_task_url ||
                md.skyvernTaskUrl ||
                md.portal_task_url ||
                md.portalTaskUrl ||
                null;
            return {
            id: String(run.id),
            case_id: String(run.case_id),
            trigger_type: run.trigger_type,
            started_at: run.started_at,
            completed_at: run.ended_at || null,
            ended_at: run.ended_at || null,
            duration_ms: run.ended_at && run.started_at
                ? new Date(run.ended_at) - new Date(run.started_at)
                : null,
            status: displayStatus,
            error: run.error || null,
            error_message: run.error || null,
            gated_reason: run.metadata?.gated_reason || null,
            lock_acquired: run.lock_acquired,
            node_trace: nodeTraceFromMetadata,
            current_node: typeof md.current_node === 'string' ? md.current_node : null,
            trigger_run_id: run.metadata?.trigger_run_id || run.metadata?.triggerRunId || null,
            skyvern_task_url: skyvernTaskUrl,
            proposal: run.proposal_id ? {
                id: run.proposal_id,
                action_type: run.proposal_action_type,
                status: run.proposal_status,
                content_preview: run.proposal_content
                    ? run.proposal_content.substring(0, 200)
                    : null
            } : null,
            metadata: md
        };
        });

        res.json({
            success: true,
            case_id: requestId,
            count: transformedRuns.length,
            runs: transformedRuns,
            agent_runs: transformedRuns
        });
    } catch (error) {
        console.error('Error fetching agent runs:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =========================================================================
// Agent Invocation & Reset
// =========================================================================

/**
 * POST /api/requests/:id/invoke-agent
 * Manually invoke the agent for a case via Trigger.dev
 */
router.post('/:id/invoke-agent', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const { trigger_type } = req.body;
    const log = logger.forCase(requestId);

    try {
        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        log.info(`Manual agent invocation requested`);

        const latestMsg = await db.query('SELECT id FROM messages WHERE case_id = $1 AND direction = \'inbound\' ORDER BY created_at DESC LIMIT 1', [requestId]);
        const triggerRun = await db.createAgentRunFull({
            case_id: requestId,
            trigger_type: trigger_type || 'MANUAL',
            status: 'queued',
            autopilot_mode: 'SUPERVISED',
            langgraph_thread_id: `manual:${requestId}:${Date.now()}`
        });
        const { handle } = await triggerDispatch.triggerTask('process-inbound', {
            runId: triggerRun.id,
            caseId: requestId,
            messageId: latestMsg.rows[0]?.id || null,
            autopilotMode: 'SUPERVISED',
        }, {
            queue: `case-${requestId}`,
            idempotencyKey: `invoke-agent:${requestId}:${triggerRun.id}`,
            idempotencyKeyTTL: '1h',
        }, {
            runId: triggerRun.id,
            caseId: requestId,
            triggerType: trigger_type || 'manual',
            source: 'requests_invoke_agent',
        });

        log.info(`Trigger.dev task triggered (run: ${handle.id})`);

        res.json({
            success: true,
            message: 'Agent invoked via Trigger.dev',
            trigger_run_id: handle.id
        });
    } catch (error) {
        log.error(`Error invoking agent: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/requests/:id/reset-to-last-inbound
 *
 * Reset case queue state and reprocess from latest inbound message.
 * Intended for deterministic "clean retest" against current pipeline logic.
 */
router.post('/:id/reset-to-last-inbound', async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    const log = logger.forCase(requestId);
    const lockToken = crypto.randomUUID();
    const lockTtlSeconds = 90;
    let resetLockAcquired = false;

    try {
        const lockResult = await db.query(
            `INSERT INTO case_operation_locks (
                case_id,
                operation,
                lock_token,
                holder_run_id,
                holder_metadata,
                acquired_at,
                expires_at
            )
            VALUES ($1, 'reset_to_last_inbound', $2, NULL, $3::jsonb, NOW(), NOW() + ($4::text || ' seconds')::interval)
            ON CONFLICT (case_id, operation)
            DO UPDATE SET
                lock_token = EXCLUDED.lock_token,
                holder_run_id = NULL,
                holder_metadata = EXCLUDED.holder_metadata,
                acquired_at = NOW(),
                expires_at = NOW() + ($4::text || ' seconds')::interval
            WHERE case_operation_locks.expires_at < NOW()
            RETURNING case_id, operation, lock_token, holder_run_id, holder_metadata, expires_at`,
            [
                requestId,
                lockToken,
                JSON.stringify({
                    source: 'requests_reset_to_last_inbound',
                    requested_at: new Date().toISOString(),
                    requester_ip: req.ip || null,
                }),
                String(lockTtlSeconds),
            ]
        );

        if (lockResult.rows[0]?.lock_token !== lockToken) {
            const existingLock = await db.query(
                `SELECT case_id, operation, holder_run_id, holder_metadata, expires_at
                 FROM case_operation_locks
                 WHERE case_id = $1
                   AND operation = 'reset_to_last_inbound'
                 LIMIT 1`,
                [requestId]
            );
            const currentLock = existingLock.rows[0] || null;
            return res.status(409).json({
                success: false,
                error: 'Reset already in progress for this case',
                lock: currentLock ? {
                    operation: currentLock.operation,
                    holder_run_id: currentLock.holder_run_id,
                    holder_metadata: currentLock.holder_metadata || null,
                    expires_at: currentLock.expires_at,
                } : null,
            });
        }
        resetLockAcquired = true;

        const caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        const latestInboundResult = await db.query(
            `SELECT id, COALESCE(received_at, created_at) AS inbound_at
             FROM messages
             WHERE case_id = $1
               AND direction = 'inbound'
             ORDER BY COALESCE(received_at, created_at) DESC
             LIMIT 1`,
            [requestId]
        );
        const latestInbound = latestInboundResult.rows[0];
        if (!latestInbound) {
            return res.status(400).json({
                success: false,
                error: 'No inbound message found for this case'
            });
        }

        log.info(`Resetting case to latest inbound message ${latestInbound.id}`);

        // Unblock any Trigger.dev waitpoints tied to active proposals so stale waiting runs can exit cleanly.
        try {
            const tokenRows = await db.query(
                `SELECT id, waitpoint_token
                 FROM proposals
                 WHERE case_id = $1
                   AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')
                   AND waitpoint_token IS NOT NULL`,
                [requestId]
            );
            if (tokenRows.rows.length > 0) {
                const { wait: triggerWait } = require('@trigger.dev/sdk');
                for (const row of tokenRows.rows) {
                    try {
                        await triggerWait.completeToken(row.waitpoint_token, {
                            action: 'DISMISS',
                            reason: `Case reset to latest inbound #${latestInbound.id}`,
                        });
                    } catch (_) {
                        // token already completed/expired
                    }
                }
            }
        } catch (_) {
            // non-fatal
        }

        // All reset mutations must be atomic on a single connection.
        const txResult = await db.withTransaction(async (txQuery) => {
            // Remove active proposals from queue.
            const dismissedProposals = await txQuery(
                `UPDATE proposals
                 SET status = 'DISMISSED',
                     updated_at = NOW(),
                     human_decision = COALESCE(human_decision, '{}'::jsonb)
                        || jsonb_build_object(
                            'auto_dismiss_reason', 'reset_to_last_inbound',
                            'auto_dismissed_at', NOW()::text,
                            'reset_anchor_message_id', $2::int
                        )
                 WHERE case_id = $1
                   AND status IN ('PENDING_APPROVAL', 'BLOCKED', 'DECISION_RECEIVED', 'PENDING_PORTAL')`,
                [requestId, latestInbound.id]
            );

            // Mark in-flight/queued runs as failed (superseded by reset).
            const failedRuns = await txQuery(
                `UPDATE agent_runs
                 SET status = 'cancelled',
                     ended_at = NOW(),
                     error = COALESCE(error, 'superseded by reset_to_last_inbound')
                 WHERE case_id = $1
                   AND status IN ('created', 'queued', 'processing', 'running', 'paused', 'waiting', 'gated')`,
                [requestId]
            );

            // Clear processed marker on anchor inbound so it can be re-run through run-engine path.
            await txQuery(
                `UPDATE messages
                 SET processed_at = NULL,
                     processed_run_id = NULL,
                     last_error = NULL
                 WHERE id = $1`,
                [latestInbound.id]
            );

            // Clear decision artifacts at/after this inbound timestamp.
            const prunedAnalyses = await txQuery(
                `DELETE FROM response_analysis
                 WHERE case_id = $1
                   AND created_at >= $2`,
                [requestId, latestInbound.inbound_at]
            );
            const prunedDecisions = await txQuery(
                `DELETE FROM agent_decisions
                 WHERE case_id = $1
                   AND created_at >= $2`,
                [requestId, latestInbound.inbound_at]
            );

            // Clear case pause state within the transaction.
            await txQuery(
                `UPDATE cases
                 SET status = 'awaiting_response',
                     requires_human = false,
                     pause_reason = NULL,
                     substatus = $2,
                     updated_at = NOW()
                 WHERE id = $1`,
                [requestId, `Reset to inbound #${latestInbound.id}; reprocessing`]
            );

            return {
                dismissed: dismissedProposals.rowCount || 0,
                failed: failedRuns.rowCount || 0,
                analysesPruned: prunedAnalyses.rowCount || 0,
                decisionsPruned: prunedDecisions.rowCount || 0,
            };
        });

        // Log activity outside the transaction (non-critical, has SSE side effects).
        await db.logActivity(
            'case_reset_to_last_inbound',
            `Reset to latest inbound #${latestInbound.id} and queued fresh processing`,
            {
                case_id: requestId,
                message_id: latestInbound.id,
                dismissed_proposals: txResult.dismissed,
                failed_runs: txResult.failed,
                analyses_pruned: txResult.analysesPruned,
                decisions_pruned: txResult.decisionsPruned,
            }
        );

        // Re-run from the anchor inbound via Trigger.dev.
        const replayRun = await db.createAgentRunFull({
            case_id: requestId,
            trigger_type: 'RESET_TO_LAST_INBOUND',
            message_id: latestInbound.id,
            status: 'queued',
            autopilot_mode: caseData.autopilot_mode || 'SUPERVISED',
            langgraph_thread_id: `reset:${requestId}:msg-${latestInbound.id}:${Date.now()}`
        });
        await db.query(
            `UPDATE case_operation_locks
             SET holder_run_id = $3,
                 holder_metadata = COALESCE(holder_metadata, '{}'::jsonb)
                   || jsonb_build_object('holder_run_id', $3::int)
             WHERE case_id = $1
               AND operation = 'reset_to_last_inbound'
               AND lock_token = $2`,
            [requestId, lockToken, replayRun.id]
        );

        const { handle } = await triggerDispatch.triggerTask('process-inbound', {
            runId: replayRun.id,
            caseId: requestId,
            messageId: latestInbound.id,
            autopilotMode: caseData.autopilot_mode || 'SUPERVISED',
            triggerType: 'RESET_TO_LAST_INBOUND',
        }, {
            queue: `case-${requestId}`,
            idempotencyKey: `reset-to-last-inbound:${requestId}:${replayRun.id}`,
            idempotencyKeyTTL: '1h',
        }, {
            runId: replayRun.id,
            caseId: requestId,
            triggerType: 'reset_to_last_inbound',
            source: 'requests_reset_to_last_inbound',
        });

        res.json({
            success: true,
            message: `Case reset to inbound #${latestInbound.id} and reprocessing queued`,
            anchor_message_id: latestInbound.id,
            run_id: replayRun.id,
            trigger_run_id: handle.id,
        });
    } catch (error) {
        log.error(`Error resetting case to latest inbound: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    } finally {
        if (resetLockAcquired) {
            try {
                await db.query(
                    `DELETE FROM case_operation_locks
                     WHERE case_id = $1
                       AND operation = 'reset_to_last_inbound'
                       AND lock_token = $2`,
                    [requestId, lockToken]
                );
            } catch (releaseErr) {
                log.warn(`Failed to release reset lock: ${releaseErr.message}`);
            }
        }
    }
});

// =========================================================================
// Replay / Dry-Run Tooling
// =========================================================================

/**
 * POST /api/requests/:id/agent-runs/:runId/replay
 * Replay an agent run for debugging purposes.
 *
 * Query params:
 * - mode: 'dry_run' (default) or 'live'
 *
 * Body (optional overrides for testing):
 * - autopilotMode: 'AUTO' | 'SUPERVISED' | 'MANUAL'
 * - feeThreshold: number (override FEE_AUTO_APPROVE_MAX)
 * - simulatePortal: boolean (pretend case has/doesn't have portal_url)
 * - humanDecision: { action: 'approve'|'adjust'|'dismiss', reason?: string }
 * - forceConfidence: number (override analysis confidence)
 *
 * Dry-run mode:
 * - Runs full agent logic
 * - Generates proposals and logs
 * - Never sends emails or takes real actions
 * - Stores diff against original run
 */
router.post('/:id/agent-runs/:runId/replay', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const runId = parseInt(req.params.runId);
    const mode = req.query.mode || 'dry_run';
    const log = logger.forCase(requestId);

    // Extract override options from request body
    const overrides = {
        autopilotMode: req.body.autopilotMode || null,
        feeThreshold: req.body.feeThreshold || null,
        simulatePortal: req.body.simulatePortal ?? null,
        humanDecision: req.body.humanDecision || null,
        forceConfidence: req.body.forceConfidence || null,
        forceActionType: req.body.forceActionType || null
    };

    try {
        // Verify case exists
        let caseData = await db.getCaseById(requestId);
        if (!caseData) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Get the original run
        const originalRun = await db.getAgentRunById(runId);
        if (!originalRun || originalRun.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Agent run not found'
            });
        }

        log.info(`Replaying agent run ${runId} in ${mode} mode`, { overrides });

        // Apply overrides to case data (for dry-run simulation)
        const effectiveCaseData = { ...caseData };
        if (overrides.autopilotMode) {
            effectiveCaseData.autopilot_mode = overrides.autopilotMode;
        }
        if (overrides.simulatePortal === true) {
            effectiveCaseData.portal_url = effectiveCaseData.portal_url || 'https://simulated-portal.example.com';
        } else if (overrides.simulatePortal === false) {
            effectiveCaseData.portal_url = null;
        }

        // Create a new agent run record for the replay
        const replayRun = await db.createAgentRun(requestId, `REPLAY_${originalRun.trigger_type}`, {
            is_replay: true,
            replay_of_run_id: runId,
            dry_run: mode === 'dry_run',
            original_trigger_type: originalRun.trigger_type,
            original_started_at: originalRun.started_at,
            overrides_applied: overrides
        });

        // Update the run to mark it as a replay
        await db.updateAgentRun(replayRun.id, {
            is_replay: true,
            replay_of_run_id: runId,
            dry_run: mode === 'dry_run'
        });

        if (mode === 'dry_run') {
            // Dry-run mode: simulate agent without taking actions
            const actionValidator = require('../../services/action-validator');

            // Get the original proposal if any
            let originalProposal = null;
            if (originalRun.proposal_id) {
                const result = await db.query(
                    'SELECT * FROM auto_reply_queue WHERE id = $1',
                    [originalRun.proposal_id]
                );
                originalProposal = result.rows[0];
            }

            // Get original proposal from proposals table too
            let originalProposalNew = null;
            if (originalRun.proposal_id) {
                const pResult = await db.query(
                    'SELECT * FROM proposals WHERE id = $1',
                    [originalRun.proposal_id]
                );
                originalProposalNew = pResult.rows[0];
            }

            // Simulate what the agent would do now
            const latestMessage = await db.getLatestInboundMessage(requestId);
            const analysis = latestMessage ? await db.getAnalysisByMessageId(latestMessage.id) : null;

            // Apply confidence override
            let effectiveConfidence = analysis?.confidence_score || 0.5;
            if (overrides.forceConfidence !== null) {
                effectiveConfidence = overrides.forceConfidence;
            }

            // Determine effective action type
            let effectiveActionType = analysis?.suggested_action || 'UNKNOWN';
            if (overrides.forceActionType) {
                effectiveActionType = overrides.forceActionType;
            }

            // Build simulated proposal
            const simulatedProposal = {
                case_id: requestId,
                action_type: effectiveActionType,
                reasoning: ['Dry-run simulation based on current case state'],
                confidence: effectiveConfidence,
                warnings: [],
                requires_human: effectiveCaseData.autopilot_mode !== 'AUTO'
            };

            // Calculate whether this would auto-execute
            const FEE_THRESHOLD = overrides.feeThreshold ||
                parseInt(process.env.FEE_AUTO_APPROVE_MAX) || 100;

            let canAutoExecute = false;
            if (effectiveCaseData.autopilot_mode === 'AUTO') {
                if (effectiveActionType === 'SEND_FOLLOWUP') {
                    canAutoExecute = true;
                } else if (effectiveActionType === 'APPROVE_FEE') {
                    const feeAmount = analysis?.extracted_fee_amount || 0;
                    canAutoExecute = feeAmount <= FEE_THRESHOLD;
                } else if (effectiveActionType === 'MARK_COMPLETE') {
                    canAutoExecute = effectiveConfidence >= 0.9;
                }
            }

            simulatedProposal.can_auto_execute = canAutoExecute;

            // Validate the simulated action
            const validation = await actionValidator.validateAction(
                requestId,
                simulatedProposal,
                analysis,
                effectiveCaseData  // Pass effective case data with overrides
            );

            // Build state snapshot for debugging
            const stateSnapshot = {
                case: {
                    id: requestId,
                    status: effectiveCaseData.status,
                    autopilot_mode: effectiveCaseData.autopilot_mode,
                    has_portal: !!effectiveCaseData.portal_url,
                    requires_human: effectiveCaseData.requires_human,
                    pause_reason: effectiveCaseData.pause_reason,
                    last_fee_quote_amount: effectiveCaseData.last_fee_quote_amount
                },
                analysis: analysis ? {
                    classification: analysis.intent,
                    suggested_action: analysis.suggested_action,
                    confidence: analysis.confidence_score,
                    fee_amount: analysis.extracted_fee_amount
                } : null,
                config: {
                    fee_threshold: FEE_THRESHOLD,
                    autopilot_enabled: effectiveCaseData.autopilot_mode !== 'MANUAL'
                }
            };

            // Build comprehensive diff
            const diff = {
                original_proposal: originalProposal ? {
                    action_type: originalProposal.action_type,
                    status: originalProposal.status,
                    confidence: originalProposal.confidence_score,
                    draft_subject: originalProposal.subject,
                    draft_body_preview: (originalProposal.generated_reply || '').substring(0, 200)
                } : (originalProposalNew ? {
                    action_type: originalProposalNew.action_type,
                    status: originalProposalNew.status,
                    confidence: originalProposalNew.confidence,
                    draft_subject: originalProposalNew.draft_subject,
                    draft_body_preview: (originalProposalNew.draft_body_text || '').substring(0, 200)
                } : null),
                simulated_proposal: {
                    action_type: simulatedProposal.action_type,
                    confidence: simulatedProposal.confidence,
                    can_auto_execute: simulatedProposal.can_auto_execute,
                    would_be_blocked: validation.blocked,
                    requires_human: simulatedProposal.requires_human
                },
                state_snapshot: stateSnapshot,
                validator_result: {
                    valid: validation.valid,
                    blocked: validation.blocked,
                    violations: validation.violations,
                    rules_checked: validation.rules_checked || []
                },
                overrides_applied: overrides,
                changes_detected: {
                    action_type_changed: originalProposal?.action_type !== simulatedProposal.action_type,
                    confidence_changed: originalProposal?.confidence_score !== simulatedProposal.confidence,
                    blocking_changed: validation.blocked !== (originalProposal?.status === 'blocked')
                },
                executed_at: new Date().toISOString()
            };

            // Simulate human decision if provided
            if (overrides.humanDecision) {
                diff.simulated_human_decision = {
                    action: overrides.humanDecision.action,
                    reason: overrides.humanDecision.reason,
                    would_result_in: overrides.humanDecision.action === 'approve'
                        ? (validation.blocked ? 'BLOCKED' : 'EXECUTED')
                        : (overrides.humanDecision.action === 'dismiss' ? 'DISMISSED' : 'ADJUSTED')
                };
            }

            await db.updateAgentRun(replayRun.id, {
                status: 'completed',
                ended_at: new Date(),
                replay_diff: JSON.stringify(diff)
            });

            // Log activity
            await db.logActivity('agent_run_replayed', `Dry-run replay of run ${runId}`, {
                case_id: requestId,
                original_run_id: runId,
                replay_run_id: replayRun.id,
                mode: 'dry_run',
                overrides_applied: Object.keys(overrides).filter(k => overrides[k] !== null).length > 0
            });

            res.json({
                success: true,
                message: 'Dry-run replay completed',
                replay_run_id: replayRun.id,
                original_run_id: runId,
                mode: 'dry_run',
                diff: diff,
                state_snapshot: stateSnapshot,
                overrides_applied: overrides
            });
        } else {
            // Live mode: actually re-run the agent
            log.warn('Live replay mode requested - queueing agent job');

            const latestMsg = await db.query('SELECT id FROM messages WHERE case_id = $1 AND direction = \'inbound\' ORDER BY created_at DESC LIMIT 1', [requestId]);
            const { handle } = await triggerDispatch.triggerTask('process-inbound', {
                runId: replayRun.id,
                caseId: requestId,
                messageId: latestMsg.rows[0]?.id || null,
                autopilotMode: 'SUPERVISED',
            }, {
                queue: `case-${requestId}`,
                idempotencyKey: `live-replay:${requestId}:${replayRun.id}`,
                idempotencyKeyTTL: '1h',
            }, {
                runId: replayRun.id,
                caseId: requestId,
                triggerType: 'replay',
                source: 'requests_live_replay',
            });

            await db.updateAgentRun(replayRun.id, {
                metadata: JSON.stringify({
                    ...replayRun.metadata,
                    trigger_run_id: handle.id
                })
            });

            res.json({
                success: true,
                message: 'Live replay queued via Trigger.dev',
                replay_run_id: replayRun.id,
                original_run_id: runId,
                mode: 'live',
                trigger_run_id: handle.id
            });
        }
    } catch (error) {
        log.error(`Error replaying agent run: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/requests/:id/agent-runs/:runId/diff
 * Get the diff for a replay run
 */
router.get('/:id/agent-runs/:runId/diff', async (req, res) => {
    const requestId = parseInt(req.params.id);
    const runId = parseInt(req.params.runId);

    try {
        const run = await db.getAgentRunById(runId);

        if (!run || run.case_id !== requestId) {
            return res.status(404).json({
                success: false,
                error: 'Agent run not found'
            });
        }

        if (!run.is_replay) {
            return res.status(400).json({
                success: false,
                error: 'This is not a replay run'
            });
        }

        // Get the original run for comparison
        let originalRun = null;
        if (run.replay_of_run_id) {
            originalRun = await db.getAgentRunById(run.replay_of_run_id);
        }

        res.json({
            success: true,
            run_id: runId,
            is_replay: true,
            dry_run: run.dry_run,
            original_run_id: run.replay_of_run_id,
            diff: run.replay_diff,
            original_run: originalRun ? {
                id: originalRun.id,
                trigger_type: originalRun.trigger_type,
                status: originalRun.status,
                started_at: originalRun.started_at,
                ended_at: originalRun.ended_at
            } : null
        });
    } catch (error) {
        console.error('Error fetching replay diff:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
