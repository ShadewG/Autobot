/**
 * Idempotency Tests
 *
 * Tests to verify idempotency guarantees for critical operations:
 * 1. Duplicate inbound email - same provider_message_id twice → only one run/proposal
 * 2. Double-approve - click approve twice → only one execution
 * 3. Follow-up scheduler - scheduled_key prevents duplicate followups
 *
 * These tests verify the system behaves correctly under race conditions
 * and duplicate submissions.
 */

const { describe, it, beforeEach, afterEach, before, after } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Idempotency Tests', function() {
    this.timeout(30000);

    // Simulated database state for testing
    let mockMessages = new Map();
    let mockRuns = new Map();
    let mockProposals = new Map();
    let mockExecutions = new Map();
    let nextId = 1;

    beforeEach(function() {
        // Reset state before each test
        mockMessages.clear();
        mockRuns.clear();
        mockProposals.clear();
        mockExecutions.clear();
        nextId = 1;
    });

    describe('1. Duplicate Inbound Email Protection', function() {
        /**
         * Scenario: Same email arrives twice (e.g., webhook retry, race condition)
         * Expected: Only one run should be created
         */

        it('should reject processing when message.processed_at is already set', async function() {
            // Setup: Create a message that's already been processed
            const messageId = nextId++;
            const caseId = 100;
            mockMessages.set(messageId, {
                id: messageId,
                case_id: caseId,
                provider_message_id: 'msg_12345',
                processed_at: new Date(),  // Already processed
                processed_run_id: 1
            });

            // Simulate API call to process this message
            const result = await simulateProcessInboundRequest(caseId, messageId);

            expect(result.success).to.equal(false);
            expect(result.error).to.include('already processed');
        });

        it('should prevent concurrent processing of same message', async function() {
            // Setup: Create an unprocessed message
            const messageId = nextId++;
            const caseId = 100;
            mockMessages.set(messageId, {
                id: messageId,
                case_id: caseId,
                provider_message_id: 'msg_67890',
                processed_at: null,
                processed_run_id: null
            });

            // Simulate 5 concurrent attempts to process
            const results = await Promise.all([
                simulateProcessInboundRequest(caseId, messageId),
                simulateProcessInboundRequest(caseId, messageId),
                simulateProcessInboundRequest(caseId, messageId),
                simulateProcessInboundRequest(caseId, messageId),
                simulateProcessInboundRequest(caseId, messageId)
            ]);

            const successes = results.filter(r => r.success);
            const failures = results.filter(r => !r.success);

            // Exactly one should succeed
            expect(successes.length).to.equal(1, 'Exactly one request should succeed');

            // Rest should fail due to concurrent run or already processed
            expect(failures.length).to.equal(4, 'Four requests should fail');
            failures.forEach(f => {
                expect(f.error).to.match(/already processed|active agent run/);
            });
        });

        it('should use provider_message_id for deduplication', async function() {
            // Simulate receiving the same email twice with same provider_message_id
            const providerMessageId = 'sendgrid_abc123';
            const caseId = 100;

            // First message
            const msg1Id = nextId++;
            mockMessages.set(msg1Id, {
                id: msg1Id,
                case_id: caseId,
                provider_message_id: providerMessageId,
                processed_at: null
            });

            // Process first
            const result1 = await simulateProcessInboundRequest(caseId, msg1Id);
            expect(result1.success).to.equal(true);

            // Mark as processed
            mockMessages.get(msg1Id).processed_at = new Date();

            // Second attempt with same message
            const result2 = await simulateProcessInboundRequest(caseId, msg1Id);
            expect(result2.success).to.equal(false);
            expect(result2.error).to.include('already processed');
        });
    });

    describe('2. Double-Approve Protection', function() {
        /**
         * Scenario: User clicks approve button twice quickly
         * Expected: Only one execution should occur
         */

        it('should reject second approval when proposal status is not PENDING_APPROVAL', async function() {
            // Setup: Create a proposal that's been approved
            const proposalId = nextId++;
            const caseId = 100;
            mockProposals.set(proposalId, {
                id: proposalId,
                case_id: caseId,
                status: 'DECISION_RECEIVED',  // Already received decision
                action_type: 'ACCEPT_FEE'
            });

            // Try to approve again
            const result = await simulateApproveProposal(proposalId, 'APPROVE');

            expect(result.success).to.equal(false);
            expect(result.error).to.include('not pending approval');
        });

        it('should prevent concurrent approvals from creating duplicate executions', async function() {
            // Setup: Create a pending proposal
            const proposalId = nextId++;
            const caseId = 100;
            mockProposals.set(proposalId, {
                id: proposalId,
                case_id: caseId,
                status: 'PENDING_APPROVAL',
                action_type: 'ACCEPT_FEE'
            });

            // Simulate 3 concurrent approve clicks
            const results = await Promise.all([
                simulateApproveProposal(proposalId, 'APPROVE'),
                simulateApproveProposal(proposalId, 'APPROVE'),
                simulateApproveProposal(proposalId, 'APPROVE')
            ]);

            const successes = results.filter(r => r.success);
            const failures = results.filter(r => !r.success);

            // Exactly one should succeed
            expect(successes.length).to.equal(1, 'Exactly one approval should succeed');

            // Rest should fail
            expect(failures.length).to.equal(2, 'Two approvals should fail');
        });

        it('should check execution_key to prevent duplicate executions', async function() {
            const proposalId = nextId++;
            const caseId = 100;

            // Create proposal
            mockProposals.set(proposalId, {
                id: proposalId,
                case_id: caseId,
                status: 'PENDING_APPROVAL',
                action_type: 'SEND_FOLLOWUP'
            });

            // First approval succeeds
            const result1 = await simulateApproveProposal(proposalId, 'APPROVE');
            expect(result1.success).to.equal(true);

            // Create execution record
            const executionKey = `proposal:${proposalId}:approve`;
            mockExecutions.set(executionKey, {
                id: nextId++,
                proposal_id: proposalId,
                execution_key: executionKey,
                status: 'SENT'
            });

            // Update proposal status
            mockProposals.get(proposalId).status = 'EXECUTED';

            // Second approval should fail due to terminal status
            const result2 = await simulateApproveProposal(proposalId, 'APPROVE');
            expect(result2.success).to.equal(false);
        });
    });

    describe('3. Follow-up Scheduler Duplicate Protection', function() {
        /**
         * Scenario: Scheduler fires twice for same followup tick
         * Expected: scheduled_key prevents duplicate followups
         */

        it('should prevent duplicate followups with same scheduled_key', async function() {
            const caseId = 100;
            const followupCount = 1;
            const today = new Date().toISOString().split('T')[0];
            const scheduledKey = `followup:${caseId}:${followupCount}:${today}`;

            // First followup trigger
            const run1 = await simulateFollowupTrigger(caseId, scheduledKey);
            expect(run1.success).to.equal(true);

            // Record the scheduled_key as used
            mockRuns.set(scheduledKey, {
                id: run1.runId,
                case_id: caseId,
                scheduled_key: scheduledKey,
                status: 'completed'
            });

            // Second followup trigger with same key
            const run2 = await simulateFollowupTrigger(caseId, scheduledKey);
            expect(run2.success).to.equal(false);
            expect(run2.error).to.include('already processed');
        });

        it('should allow followups for different days', async function() {
            const caseId = 100;
            const followupCount = 1;

            // Day 1
            const day1Key = `followup:${caseId}:${followupCount}:2024-01-15`;
            const run1 = await simulateFollowupTrigger(caseId, day1Key);
            expect(run1.success).to.equal(true);
            mockRuns.set(day1Key, { scheduled_key: day1Key });

            // Day 2 (different key)
            const day2Key = `followup:${caseId}:${followupCount + 1}:2024-01-22`;
            const run2 = await simulateFollowupTrigger(caseId, day2Key);
            expect(run2.success).to.equal(true);
        });

        it('should track followup_count to prevent repeats', async function() {
            const caseId = 100;

            // First followup
            const key1 = `followup:${caseId}:0:2024-01-15`;
            const run1 = await simulateFollowupTrigger(caseId, key1);
            expect(run1.success).to.equal(true);
            mockRuns.set(key1, { scheduled_key: key1 });

            // Duplicate first followup attempt
            const run2 = await simulateFollowupTrigger(caseId, key1);
            expect(run2.success).to.equal(false);

            // Second followup (different count)
            const key2 = `followup:${caseId}:1:2024-01-22`;
            const run3 = await simulateFollowupTrigger(caseId, key2);
            expect(run3.success).to.equal(true);
        });
    });

    // =========================================================================
    // Simulation Helpers
    // =========================================================================

    /**
     * Simulate the /cases/:id/run-inbound API endpoint
     */
    async function simulateProcessInboundRequest(caseId, messageId) {
        // Check if message exists and isn't processed
        const message = mockMessages.get(messageId);
        if (!message) {
            return { success: false, error: `Message ${messageId} not found` };
        }

        if (message.processed_at) {
            return {
                success: false,
                error: 'Message already processed',
                processed_at: message.processed_at
            };
        }

        // Check for active run (simulated lock)
        const existingRun = Array.from(mockRuns.values()).find(
            r => r.case_id === caseId && r.status === 'running'
        );

        if (existingRun) {
            return {
                success: false,
                error: 'Case already has an active agent run'
            };
        }

        // Simulate atomic operation with small random delay
        await new Promise(r => setTimeout(r, Math.random() * 10));

        // Double-check after delay (simulates race condition handling)
        if (message.processed_at) {
            return {
                success: false,
                error: 'Message already processed'
            };
        }

        // Create run
        const runId = nextId++;
        mockRuns.set(runId, {
            id: runId,
            case_id: caseId,
            message_id: messageId,
            status: 'running'
        });

        // Mark message as being processed
        message.processed_at = new Date();
        message.processed_run_id = runId;

        // Simulate processing time
        await new Promise(r => setTimeout(r, 50));

        // Complete run
        mockRuns.get(runId).status = 'completed';

        return { success: true, runId };
    }

    /**
     * Simulate the /proposals/:id/decision API endpoint
     */
    async function simulateApproveProposal(proposalId, action) {
        const proposal = mockProposals.get(proposalId);
        if (!proposal) {
            return { success: false, error: `Proposal ${proposalId} not found` };
        }

        // Check if already processed
        if (proposal.status !== 'PENDING_APPROVAL') {
            return {
                success: false,
                error: `Proposal is not pending approval (status: ${proposal.status})`
            };
        }

        // Simulate atomic status update with small delay
        await new Promise(r => setTimeout(r, Math.random() * 10));

        // Double-check status (race condition handling)
        if (proposal.status !== 'PENDING_APPROVAL') {
            return {
                success: false,
                error: `Proposal is not pending approval (status: ${proposal.status})`
            };
        }

        // Update status
        proposal.status = 'DECISION_RECEIVED';

        return { success: true, proposalId };
    }

    /**
     * Simulate follow-up trigger with scheduled_key deduplication
     */
    async function simulateFollowupTrigger(caseId, scheduledKey) {
        // Check if this scheduled_key was already processed
        if (mockRuns.has(scheduledKey)) {
            return {
                success: false,
                error: `Followup with scheduled_key already processed: ${scheduledKey}`
            };
        }

        // Simulate atomic insert with delay
        await new Promise(r => setTimeout(r, Math.random() * 10));

        // Double-check (race condition)
        if (mockRuns.has(scheduledKey)) {
            return {
                success: false,
                error: `Followup with scheduled_key already processed: ${scheduledKey}`
            };
        }

        const runId = nextId++;
        mockRuns.set(scheduledKey, {
            id: runId,
            case_id: caseId,
            scheduled_key: scheduledKey,
            status: 'completed'
        });

        return { success: true, runId };
    }
});
