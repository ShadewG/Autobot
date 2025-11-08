const { OpenAI } = require('openai');
const db = require('./database');
const aiService = require('./ai-service');
const notificationService = require('./notification-service');
let emailQueueInstance = null;
function getEmailQueue() {
    if (!emailQueueInstance) {
        ({ emailQueue: emailQueueInstance } = require('../queues/email-queue'));
    }
    return emailQueueInstance;
}

/**
 * FOIA Case Manager Agent
 *
 * Autonomous agent that handles FOIA cases from initial request through delivery.
 * Uses GPT-5 with tool calling to make strategic decisions about:
 * - How to respond to agency replies
 * - When to send follow-ups
 * - Whether to escalate to humans
 * - How to handle denials, fees, and requests for clarification
 */
class FOIACaseAgent {
    constructor() {
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });

        this.systemPrompt = `You are a FOIA Case Manager Agent for a YouTube true-crime media company.

Your mission: Move each case from initial request → delivered records (or exhausted denials) with maximum success rate and minimal cost.

CORE PRINCIPLES:
1. Always read the full case context and email history first
2. Respect jurisdiction laws and deadlines
3. Prefer precise, narrowly scoped, polite emails
4. Escalate to humans when things are unusual, high-risk, or ambiguous
5. Never invent facts or deadlines - when unsure, escalate
6. Use human-like timing (2-10 hour delays for replies)

DECISION FRAMEWORK:

For denials:
- Assess denial strength (weak/medium/strong)
- Research state laws if denial seems challengeable
- Consider success probability vs. cost
- Escalate if legal risk is high

For fee notices:
- Evaluate if fee is reasonable for requested records
- If > $100, escalate for human decision
- If reasonable, send acceptance

For requests for clarification:
- Provide the requested info politely
- Narrow scope if that helps expedite

For approvals:
- Update status to success
- Cancel follow-ups
- Log for adaptive learning

For no response (follow-ups):
- Check state deadline laws
- Send polite follow-up after reasonable time
- Escalate after 2-3 attempts with no response

TRIGGER TYPES:
You will be invoked with different trigger types:
- "agency_reply" - Agency sent a reply (denial, approval, fee notice, etc.)
- "time_based_followup" - Scheduled follow-up is due
- "manual_review" - Human re-invoked you for a second look

Treat these differently. For time_based_followup, focus on deadlines and whether to follow up.
For agency_reply, analyze the agency's response and decide how to reply.

AVAILABLE TOOLS:
- fetch_case_context: Get full case details, messages, analysis
- draft_denial_rebuttal: Research laws + generate rebuttal
- draft_clarification: Respond to info requests
- draft_followup: Generate follow-up email
- send_email: Send email with human-like delay
- schedule_followup: Schedule future follow-up
- update_case_status: Update case status (including 'needs_human_review')
- escalate_to_human: Flag case for human review (automatically sets status to 'needs_human_review')
- log_decision: Log your reasoning (REQUIRED at end of every run)

PROCESS:
1. Fetch case context first (always)
2. Analyze current situation
3. Think through options
4. Decide best action
5. Execute tool(s)
6. Log decision for learning (REQUIRED)

Always explain your reasoning before taking action.
You MUST call log_decision at the end of every run with your reasoning, action, and confidence.`;
    }

    /**
     * Tool definitions for OpenAI function calling
     */
    getToolDefinitions() {
        return [
            {
                type: 'function',
                function: {
                    name: 'fetch_case_context',
                    description: 'Fetch complete case details including all messages, analysis, and current status',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'The case ID to fetch context for'
                            }
                        },
                        required: ['case_id']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'draft_denial_rebuttal',
                    description: 'Research state laws and draft a rebuttal to an agency denial. Automatically determines appropriate tone based on denial type and strength.',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            message_id: {
                                type: 'number',
                                description: 'ID of the denial message'
                            }
                        },
                        required: ['case_id', 'message_id']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'draft_clarification',
                    description: 'Draft a response to agency request for more information',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            message_id: {
                                type: 'number',
                                description: 'ID of the message requesting clarification'
                            }
                        },
                        required: ['case_id', 'message_id']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'draft_followup',
                    description: 'Draft a follow-up email to an unresponsive agency',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            attempt_number: {
                                type: 'number',
                                description: 'Which follow-up attempt (1, 2, 3)'
                            }
                        },
                        required: ['case_id', 'attempt_number']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'send_email',
                    description: 'Send an email via SendGrid with human-like delay',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            subject: {
                                type: 'string',
                                description: 'Email subject'
                            },
                            body_html: {
                                type: 'string',
                                description: 'Email body in HTML'
                            },
                            body_text: {
                                type: 'string',
                                description: 'Email body in plain text'
                            },
                            delay_hours: {
                                type: 'number',
                                description: 'Hours to delay before sending (2-10 for human-like)'
                            },
                            message_type: {
                                type: 'string',
                                enum: ['auto_reply', 'followup', 'rebuttal', 'clarification'],
                                description: 'Type of message being sent'
                            }
                        },
                        required: ['case_id', 'subject', 'body_html', 'body_text', 'message_type']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'schedule_followup',
                    description: 'Schedule a future follow-up for a case',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            days_from_now: {
                                type: 'number',
                                description: 'Days until follow-up should be sent'
                            },
                            reason: {
                                type: 'string',
                                description: 'Reason for follow-up'
                            }
                        },
                        required: ['case_id', 'days_from_now']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'update_case_status',
                    description: 'Update the status of a case',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            status: {
                                type: 'string',
                                enum: ['ready_to_send', 'sent', 'awaiting_response', 'approved', 'denied', 'needs_rebuttal', 'pending_fee_decision', 'needs_human_review', 'completed'],
                                description: 'New status'
                            },
                            substatus: {
                                type: 'string',
                                description: 'Optional substatus for more detail'
                            }
                        },
                        required: ['case_id', 'status']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'escalate_to_human',
                    description: 'Flag a case for human review when situation is complex, risky, or unclear',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            reason: {
                                type: 'string',
                                description: 'Why human review is needed'
                            },
                            urgency: {
                                type: 'string',
                                enum: ['low', 'medium', 'high'],
                                description: 'How urgent is the review'
                            },
                            suggested_action: {
                                type: 'string',
                                description: 'Optional suggestion for what human should do'
                            }
                        },
                        required: ['case_id', 'reason', 'urgency']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'log_decision',
                    description: 'Log your reasoning and decision for this case (for learning)',
                    parameters: {
                        type: 'object',
                        properties: {
                            case_id: {
                                type: 'number',
                                description: 'Case ID'
                            },
                            reasoning: {
                                type: 'string',
                                description: 'Your reasoning for the decision'
                            },
                            action_taken: {
                                type: 'string',
                                description: 'What action you decided to take'
                            },
                            confidence: {
                                type: 'number',
                                description: 'Confidence level 0-1'
                            }
                        },
                        required: ['case_id', 'reasoning', 'action_taken']
                    }
                }
            }
        ];
    }

    /**
     * Main agent handler - called by workers
     */
    async handleCase(caseId, trigger) {
        console.log(`\n🤖 FOIA Agent handling case ${caseId}`);
        console.log(`   Trigger: ${trigger.type}`);

        try {
            // Prepare initial message for agent
            const triggerContext = {
                case_id: caseId,
                type: trigger.type,
                message_id: trigger.messageId || null,
                timestamp: new Date().toISOString()
            };

            const messages = [
                {
                    role: 'system',
                    content: this.systemPrompt
                },
                {
                    role: 'user',
                    content: `TRIGGER:
${JSON.stringify(triggerContext, null, 2)}

The current case ID is ${caseId}.
First, call fetch_case_context with { "case_id": ${caseId} }.
Then analyze the situation and decide what action to take.`
                }
            ];

            // Agent loop (max 5 iterations to prevent runaway)
            let iteration = 0;
            const maxIterations = 5;
            let completed = false;
            let decisionLogged = false;
            let decisionReminderSent = false;
            let caseContextErrorHandled = false;

            // Track expensive tool usage to prevent repeated calls
            let expensiveToolCalls = 0;
            const expensiveTools = ['draft_denial_rebuttal', 'draft_clarification', 'draft_followup'];

            while (!completed && iteration < maxIterations) {
                iteration++;
                console.log(`\n   🔄 Agent iteration ${iteration}/${maxIterations}`);

                const response = await this.openai.chat.completions.create({
                    model: 'gpt-5',
                    messages: messages,
                    tools: this.getToolDefinitions(),
                    tool_choice: 'auto'
                });

                const assistantMessage = response.choices[0].message;
                messages.push(assistantMessage);

                // If agent wants to use tools
                if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                    console.log(`   🛠️  Agent calling ${assistantMessage.tool_calls.length} tool(s)`);

                    const respondedToolIds = new Set();

                    for (const toolCall of assistantMessage.tool_calls) {
                        const functionName = toolCall.function.name;
                        let functionArgs;

                        try {
                            functionArgs = JSON.parse(toolCall.function.arguments);
                        } catch (parseError) {
                            console.error(`Failed to parse arguments for ${functionName}:`, parseError);
                            messages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: JSON.stringify({
                                    error: `Could not parse arguments for ${functionName}: ${parseError.message}`
                                })
                            });
                            respondedToolIds.add(toolCall.id);
                            continue;
                        }

                        console.log(`      → ${functionName}(${JSON.stringify(functionArgs).substring(0, 100)}...)`);

                        // Track expensive tool calls
                        if (expensiveTools.includes(functionName)) {
                            expensiveToolCalls++;
                        }

                        // Execute the tool
                        const result = await this.executeTool(functionName, functionArgs);

                        if (functionName === 'log_decision' && !(result && result.error)) {
                            decisionLogged = true;
                        }

                        if (functionName === 'fetch_case_context' && result && result.error && !caseContextErrorHandled) {
                            caseContextErrorHandled = true;
                            messages.push({
                                role: 'system',
                                content: `fetch_case_context returned an error: ${result.error}. Call escalate_to_human with urgency 'high' explaining that the case context could not be loaded.`
                            });
                        }

                        // Add tool result to conversation
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify(result)
                        });
                        respondedToolIds.add(toolCall.id);
                    }

                    const missingResponses = assistantMessage.tool_calls
                        .filter(call => !respondedToolIds.has(call.id));

                    if (missingResponses.length > 0) {
                        console.warn(`   ⚠️  Missing tool responses detected, adding fallback errors for: ${missingResponses.map(c => c.function?.name || c.id).join(', ')}`);
                        for (const missingCall of missingResponses) {
                            messages.push({
                                role: 'tool',
                                tool_call_id: missingCall.id,
                                content: JSON.stringify({
                                    error: `Tool execution skipped due to internal error. Please retry ${missingCall.function?.name || 'the tool'}.`
                                })
                            });
                        }
                    }

                    // Guard rail: Warn if too many expensive drafts
                    if (expensiveToolCalls > 2) {
                        console.log(`   ⚠️  Warning: Agent has called expensive tools ${expensiveToolCalls} times`);
                        messages.push({
                            role: 'system',
                            content: 'You have already drafted multiple emails. Do not draft another unless there is genuinely new information or a different approach is needed. Consider if you should just send what you have or escalate to human.'
                        });
                    }

                    if (!decisionLogged && !decisionReminderSent) {
                        decisionReminderSent = true;
                        messages.push({
                            role: 'system',
                            content: 'You have not yet called log_decision. Before finishing, call log_decision with your reasoning, action, and confidence.'
                        });
                    }
                } else {
                    // No more tools to call - agent is done
                    console.log(`   ✅ Agent completed`);
                    if (assistantMessage.content) {
                        console.log(`   💭 Final reasoning: ${assistantMessage.content.substring(0, 200)}...`);
                    }
                    completed = true;
                }
            }

            if (iteration >= maxIterations) {
                console.log(`   ⚠️  Agent reached max iterations (${maxIterations})`);
            }

            if (!decisionLogged) {
                console.log(`   ⚠️  Agent finished without logging a decision, recording fallback entry`);
                try {
                    await this.logDecision({
                        case_id: caseId,
                        reasoning: 'Agent completed without explicitly calling log_decision.',
                        action_taken: 'unknown',
                        confidence: 0.0
                    });
                    decisionLogged = true;
                } catch (fallbackError) {
                    console.error('Failed to record fallback decision:', fallbackError);
                }
            }

            return {
                success: true,
                iterations: iteration,
                final_message: messages[messages.length - 1].content
            };

        } catch (error) {
            console.error(`❌ Agent error for case ${caseId}:`, error);

            // Log error for debugging
            await db.logActivity('agent_error', `Agent error: ${error.message}`, {
                case_id: caseId,
                trigger: trigger,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * Execute a tool call
     */
    async executeTool(functionName, args) {
        try {
            switch (functionName) {
                case 'fetch_case_context':
                    return await this.fetchCaseContext(args.case_id);

                case 'draft_denial_rebuttal':
                    return await this.draftDenialRebuttal(args);

                case 'draft_clarification':
                    return await this.draftClarification(args);

                case 'draft_followup':
                    return await this.draftFollowup(args);

                case 'send_email':
                    return await this.sendEmail(args);

                case 'schedule_followup':
                    return await this.scheduleFollowup(args);

                case 'update_case_status':
                    return await this.updateCaseStatus(args);

                case 'escalate_to_human':
                    return await this.escalateToHuman(args);

                case 'log_decision':
                    return await this.logDecision(args);

                default:
                    return { error: `Unknown tool: ${functionName}` };
            }
        } catch (err) {
            console.error(`Tool ${functionName} failed:`, err);
            return { error: `Tool ${functionName} failed: ${err.message}` };
        }
    }

    /**
     * TOOL IMPLEMENTATIONS
     */

    async fetchCaseContext(caseId) {
        console.log(`      📊 Fetching context for case ${caseId}`);

        // Get case data
        const caseData = await db.getCaseById(caseId);
        if (!caseData) {
            return { error: 'Case not found' };
        }

        // Get all messages in thread
        const messages = await db.query(
            'SELECT * FROM messages WHERE case_id = $1 ORDER BY created_at ASC',
            [caseId]
        );

        // Get latest analysis if exists
        const latestAnalysis = await db.query(
            'SELECT * FROM response_analysis WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1',
            [caseId]
        );

        // Get email thread
        const thread = await db.getThreadByCaseId(caseId);

        // Get scheduled follow-ups
        const followUps = await db.query(
            `
            SELECT *
            FROM follow_up_schedule
            WHERE case_id = $1
              AND status = 'scheduled'
            ORDER BY next_followup_date ASC
            `,
            [caseId]
        );

        return {
            case: caseData,
            messages: messages.rows,
            latest_analysis: latestAnalysis.rows[0] || null,
            thread: thread,
            scheduled_followups: followUps.rows
        };
    }

    async draftDenialRebuttal({ case_id, message_id }) {
        console.log(`      ✍️  Drafting denial rebuttal for case ${case_id}`);

        // Fetch message and case
        const message = await db.query('SELECT * FROM messages WHERE id = $1', [message_id]);
        const caseData = await db.getCaseById(case_id);

        // Get analysis
        const analysis = await db.query(
            'SELECT * FROM response_analysis WHERE message_id = $1',
            [message_id]
        );

        if (!message.rows[0] || !caseData || !analysis.rows[0]) {
            return { error: 'Missing data for rebuttal generation' };
        }

        // Use existing AI service to generate rebuttal
        const rebuttal = await aiService.generateDenialRebuttal(
            message.rows[0],
            analysis.rows[0],
            caseData
        );

        return {
            success: true,
            subject: `Re: ${caseData.case_name} - Response to Denial`,
            body_html: rebuttal.bodyHtml,
            body_text: rebuttal.bodyText
        };
    }

    async draftClarification({ case_id, message_id }) {
        console.log(`      ✍️  Drafting clarification for case ${case_id}`);

        const message = await db.query('SELECT * FROM messages WHERE id = $1', [message_id]);
        const caseData = await db.getCaseById(case_id);
        const analysis = await db.query(
            'SELECT * FROM response_analysis WHERE message_id = $1',
            [message_id]
        );

        if (!message.rows[0] || !caseData || !analysis.rows[0]) {
            return { error: 'Missing data for clarification' };
        }

        // Use existing AI service
        const reply = await aiService.generateAutoReply(
            message.rows[0],
            analysis.rows[0],
            caseData
        );

        return {
            success: true,
            subject: `Re: ${caseData.case_name} - Clarification`,
            body_html: reply.bodyHtml,
            body_text: reply.bodyText
        };
    }

    async draftFollowup({ case_id, attempt_number }) {
        console.log(`      ✍️  Drafting follow-up #${attempt_number} for case ${case_id}`);

        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return { error: 'Case not found' };
        }

        // Use existing AI service
        const followup = await aiService.generateFollowUp(caseData, attempt_number);

        return {
            success: true,
            subject: `Follow-up: ${caseData.case_name}`,
            body_html: followup.bodyHtml,
            body_text: followup.bodyText,
            attempt: attempt_number
        };
    }

    async sendEmail({ case_id, subject, body_html, body_text, delay_hours = 3, message_type }) {
        const caseData = await db.getCaseById(case_id);
        if (!caseData) {
            return { error: 'Case not found' };
        }

        const isTestCase =
            (caseData.notion_page_id && caseData.notion_page_id.startsWith('test-')) ||
            (caseData.case_name && caseData.case_name.toLowerCase().includes('test')) ||
            (subject && subject.includes('[TEST]'));

        let delay = typeof delay_hours === 'number' ? delay_hours : 3;

        if (isTestCase) {
            console.log(`      ⚡ Test case detected for case ${case_id}, sending immediately`);
            delay = 0;
        } else {
            if (delay < 2) {
                console.warn(`      ⚠️  delay_hours ${delay} below minimum, clamping to 2`);
                delay = 2;
            } else if (delay > 10) {
                console.warn(`      ⚠️  delay_hours ${delay} above maximum, clamping to 10`);
                delay = 10;
            }
        }

        console.log(`      📧 Scheduling email for case ${case_id} (${delay}h delay)`);

        // Queue email with delay
        const sendAt = new Date(Date.now() + delay * 60 * 60 * 1000);

        const queue = getEmailQueue();
        await queue.add('send-email', {
            caseId: case_id,
            subject: subject,
            bodyHtml: body_html,
            bodyText: body_text,
            messageType: message_type
        }, {
            delay: delay * 60 * 60 * 1000 // Convert to milliseconds
        });

        return {
            success: true,
            scheduled_for: sendAt.toISOString(),
            delay_hours: delay,
            message_type: message_type
        };
    }

    async scheduleFollowup({ case_id, days_from_now, reason = 'No response' }) {
        console.log(`      📅 Scheduling follow-up for case ${case_id} in ${days_from_now} days`);

        const nextDate = new Date(Date.now() + days_from_now * 24 * 60 * 60 * 1000);
        const thread = await db.getThreadByCaseId(case_id);

        await db.createFollowUpSchedule({
            case_id: case_id,
            thread_id: thread ? thread.id : null,
            next_followup_date: nextDate,
            followup_count: 0,
            auto_send: true,
            status: 'scheduled'
        });

        await db.logActivity('followup_scheduled', `Follow-up scheduled for ${days_from_now} days`, {
            case_id: case_id,
            next_followup_date: nextDate.toISOString(),
            reason: reason
        });

        return {
            success: true,
            scheduled_for: nextDate.toISOString(),
            days_from_now: days_from_now
        };
    }

    async updateCaseStatus({ case_id, status, substatus = null }) {
        console.log(`      🔄 Updating case ${case_id} status: ${status}`);

        await db.updateCaseStatus(case_id, status, {
            substatus: substatus
        });

        return {
            success: true,
            new_status: status,
            substatus: substatus
        };
    }

    async escalateToHuman({ case_id, reason, urgency, suggested_action = null }) {
        console.log(`      🚨 Escalating case ${case_id} to human (${urgency} urgency)`);

        // Get case details for notification
        const caseData = await db.getCaseById(case_id);

        // Create escalation record
        await db.query(`
            INSERT INTO escalations (case_id, reason, urgency, suggested_action, status, created_at)
            VALUES ($1, $2, $3, $4, 'pending', NOW())
        `, [case_id, reason, urgency, suggested_action]);

        // Update case status
        await db.updateCaseStatus(case_id, 'needs_human_review', {
            escalation_reason: reason
        });

        // Log activity
        await db.logActivity('escalated_to_human', reason, {
            case_id: case_id,
            urgency: urgency
        });

        // Send notification via Discord/Notion
        try {
            await notificationService.notifyEscalation({
                case_id: case_id,
                case_name: caseData.case_name,
                agency_name: caseData.agency_name,
                reason: reason,
                urgency: urgency,
                suggested_action: suggested_action
            });
        } catch (error) {
            console.error(`Failed to send escalation notification:`, error.message);
        }

        console.log(`      ✅ Escalation complete and notification sent`);

        return {
            success: true,
            escalated: true,
            urgency: urgency,
            reason: reason
        };
    }

    async logDecision({ case_id, reasoning, action_taken, confidence = 0.8 }) {
        console.log(`      📝 Logging decision for case ${case_id}`);

        await db.query(`
            INSERT INTO agent_decisions (case_id, reasoning, action_taken, confidence, created_at)
            VALUES ($1, $2, $3, $4, NOW())
        `, [case_id, reasoning, action_taken, confidence]);

        return {
            success: true,
            logged: true
        };
    }
}

module.exports = new FOIACaseAgent();
