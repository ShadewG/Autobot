const Anthropic = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');
const db = require('./database');

/**
 * Portal Agent using Anthropic Computer Use
 *
 * This agent can autonomously navigate and fill FOIA portals using:
 * - Screenshot analysis (vision)
 * - Browser control (Playwright)
 * - Multi-step reasoning
 * - Error recovery
 */
class PortalAgentService {
    constructor() {
        this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        this.browser = null;
    }

    /**
     * Launch browser for agent to control
     */
    async launchBrowser() {
        if (!this.browser) {
            console.log('🌐 Launching browser for agent...');
            this.browser = await chromium.launch({
                headless: false, // Keep visible so you can watch the agent work!
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
        }
        return this.browser;
    }

    /**
     * Agent-powered portal submission
     * The agent makes autonomous decisions about navigation and form filling
     */
    async submitToPortal(caseData, portalUrl, options = {}) {
        const { maxSteps = 50, dryRun = false } = options;

        let context, page;
        const stepLog = [];

        try {
            console.log(`🤖 Starting autonomous portal submission for case: ${caseData.case_name}`);
            console.log(`   Portal: ${portalUrl}`);
            console.log(`   Max steps: ${maxSteps}`);
            console.log(`   Dry run: ${dryRun}`);

            const browser = await this.launchBrowser();
            context = await browser.newContext({
                viewport: { width: 1280, height: 720 }
            });
            page = await context.newPage();

            // Navigate to portal
            await page.goto(portalUrl, { waitUntil: 'networkidle', timeout: 30000 });
            console.log(`✅ Navigated to portal`);

            // Build the instruction for the agent
            const instruction = this.buildInstruction(caseData, dryRun);

            // Start agentic loop
            let currentStep = 0;
            let completed = false;
            const conversationHistory = [];

            while (currentStep < maxSteps && !completed) {
                currentStep++;
                console.log(`\n🔄 Step ${currentStep}/${maxSteps}`);

                // Take screenshot for agent to analyze
                const screenshot = await page.screenshot({ fullPage: false });
                const screenshotBase64 = screenshot.toString('base64');

                // Get page state
                const pageState = await this.getPageState(page);

                // Call Claude with vision to decide next action
                const response = await this.anthropic.messages.create({
                    model: 'claude-3-5-sonnet-20241022',
                    max_tokens: 4096,
                    messages: [
                        ...conversationHistory,
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: 'image/png',
                                        data: screenshotBase64
                                    }
                                },
                                {
                                    type: 'text',
                                    text: currentStep === 1
                                        ? `${instruction}\n\nCurrent URL: ${page.url()}\nPage title: ${await page.title()}\n\n${pageState}`
                                        : `Continue with the task. Current URL: ${page.url()}\n\n${pageState}`
                                }
                            ]
                        }
                    ],
                    system: this.getSystemPrompt()
                });

                // Parse agent's decision
                const agentMessage = response.content[0].text;
                console.log(`🧠 Agent thinking: ${agentMessage.substring(0, 200)}...`);

                conversationHistory.push(
                    { role: 'user', content: agentMessage },
                    { role: 'assistant', content: response.content[0].text }
                );

                // Extract and execute action
                const action = this.parseAction(agentMessage);

                if (action.type === 'complete') {
                    console.log(`✅ Agent reports: Task completed!`);
                    completed = true;
                    break;
                }

                if (action.type === 'error') {
                    console.log(`❌ Agent reports: ${action.message}`);
                    throw new Error(action.message);
                }

                // Execute the action
                const actionResult = await this.executeAction(page, action);

                stepLog.push({
                    step: currentStep,
                    action: action,
                    result: actionResult,
                    screenshot: screenshotBase64,
                    url: page.url()
                });

                // Add result back to conversation
                conversationHistory.push({
                    role: 'user',
                    content: `Action result: ${JSON.stringify(actionResult)}`
                });

                // Small delay to let page settle
                await page.waitForTimeout(1000);
            }

            if (!completed && currentStep >= maxSteps) {
                throw new Error(`Agent reached max steps (${maxSteps}) without completing`);
            }

            // Final screenshot
            const finalScreenshot = await page.screenshot({ fullPage: true });

            return {
                success: true,
                caseId: caseData.id,
                portalUrl: portalUrl,
                stepsCompleted: currentStep,
                stepLog: stepLog,
                finalScreenshot: finalScreenshot.toString('base64'),
                finalUrl: page.url(),
                dryRun
            };

        } catch (error) {
            console.error('❌ Portal agent failed:', error);

            // Take error screenshot
            let errorScreenshot = null;
            if (page) {
                try {
                    errorScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
                } catch (e) {
                    console.error('Could not capture error screenshot');
                }
            }

            return {
                success: false,
                error: error.message,
                stepLog: stepLog,
                errorScreenshot
            };
        } finally {
            if (page) await page.close();
            if (context) await context.close();
        }
    }

    /**
     * Build instruction for the agent
     */
    buildInstruction(caseData, dryRun) {
        const instruction = `You are an AI agent that fills out FOIA (Freedom of Information Act) request forms on government websites.

YOUR TASK:
${dryRun ? 'Fill out the form but DO NOT submit it (dry run mode).' : 'Fill out and submit the form completely.'}

INFORMATION TO SUBMIT:
- Requester Name: ${caseData.subject_name || 'Not provided'}
- Agency: ${caseData.agency_name || 'Not provided'}
- State: ${caseData.state || 'Not provided'}
- Incident Date: ${caseData.incident_date || 'Not provided'}
- Incident Location: ${caseData.incident_location || 'Not provided'}
- Records Requested: ${caseData.requested_records || 'Body-worn camera footage, dashcam footage, 911 calls, incident reports'}
- Additional Details: ${caseData.additional_details || 'Request for all records related to this incident'}

INSTRUCTIONS:
1. Analyze the form on the screen
2. Fill in all relevant fields with the information above
3. Handle dropdowns, date pickers, checkboxes appropriately
4. If a field is required but we don't have data, use reasonable defaults
5. ${dryRun ? 'Stop before clicking submit' : 'Click submit when all fields are filled'}
6. If you encounter errors, try to fix them autonomously
7. If you get stuck, explain what's blocking you

RESPONSE FORMAT:
Always respond with your thought process and then an action in this format:

THOUGHT: [Your analysis of what you see and what you should do next]
ACTION: [One of: click, type, select, scroll, wait, complete, error]
TARGET: [CSS selector or description of element]
VALUE: [For type/select actions, what value to use]
REASON: [Why you're taking this action]

When task is done, respond with:
THOUGHT: Form is complete and ${dryRun ? 'ready to submit (but not submitting in dry run mode)' : 'submitted successfully'}
ACTION: complete`;

        return instruction;
    }

    /**
     * System prompt for agent behavior
     */
    getSystemPrompt() {
        return `You are an expert at filling out web forms autonomously. You can:
- Analyze screenshots to understand form layouts
- Make intelligent decisions about which fields to fill
- Handle errors and adapt your strategy
- Navigate complex multi-step forms
- Use CSS selectors to interact with elements

Be methodical, careful, and explain your reasoning. If something doesn't work, try alternative approaches.`;
    }

    /**
     * Get current page state to help agent make decisions
     */
    async getPageState(page) {
        const state = await page.evaluate(() => {
            // Get all visible input fields
            const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
                .filter(el => el.offsetParent !== null)
                .map(el => ({
                    type: el.type || el.tagName,
                    name: el.name || el.id,
                    label: el.labels?.[0]?.textContent || '',
                    placeholder: el.placeholder || '',
                    required: el.required,
                    value: el.value
                }));

            // Get all visible buttons
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'))
                .filter(el => el.offsetParent !== null)
                .map(el => ({
                    text: el.textContent || el.value,
                    type: el.type
                }));

            return {
                inputCount: inputs.length,
                inputs: inputs.slice(0, 10), // Limit to first 10
                buttonCount: buttons.length,
                buttons: buttons
            };
        });

        return JSON.stringify(state, null, 2);
    }

    /**
     * Parse action from agent's response
     */
    parseAction(agentResponse) {
        // Simple parser - in production, use more robust parsing
        const lines = agentResponse.split('\n');
        const action = {};

        for (const line of lines) {
            if (line.startsWith('ACTION:')) {
                action.type = line.replace('ACTION:', '').trim().toLowerCase();
            } else if (line.startsWith('TARGET:')) {
                action.target = line.replace('TARGET:', '').trim();
            } else if (line.startsWith('VALUE:')) {
                action.value = line.replace('VALUE:', '').trim();
            } else if (line.startsWith('REASON:')) {
                action.reason = line.replace('REASON:', '').trim();
            }
        }

        if (!action.type) {
            action.type = 'wait'; // Default to wait if unclear
        }

        return action;
    }

    /**
     * Execute the action decided by agent
     */
    async executeAction(page, action) {
        console.log(`⚡ Executing: ${action.type} - ${action.reason || ''}`);

        try {
            switch (action.type) {
                case 'click':
                    await page.click(action.target);
                    return { success: true, action: 'clicked', target: action.target };

                case 'type':
                    await page.fill(action.target, action.value);
                    return { success: true, action: 'typed', target: action.target, value: action.value };

                case 'select':
                    await page.selectOption(action.target, action.value);
                    return { success: true, action: 'selected', target: action.target, value: action.value };

                case 'scroll':
                    await page.evaluate(() => window.scrollBy(0, 300));
                    return { success: true, action: 'scrolled' };

                case 'wait':
                    await page.waitForTimeout(2000);
                    return { success: true, action: 'waited' };

                case 'complete':
                    return { success: true, action: 'completed' };

                case 'error':
                    return { success: false, action: 'error', message: action.reason };

                default:
                    console.warn(`⚠️  Unknown action: ${action.type}`);
                    return { success: false, action: 'unknown', type: action.type };
            }
        } catch (error) {
            console.error(`❌ Action failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

module.exports = new PortalAgentService();
