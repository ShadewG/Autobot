const Anthropic = require('@anthropic-ai/sdk');
const { chromium } = require('playwright-core');
const { Hyperbrowser } = require('@hyperbrowser/sdk');
const PortalAgentKit = require('../agentkit/portal-agent-kit');

/**
 * Portal Agent using Anthropic Computer Use + Hyperbrowser
 *
 * This agent can autonomously navigate and fill FOIA portals using:
 * - Screenshot analysis (vision)
 * - Cloud browser control (Hyperbrowser)
 * - Multi-step reasoning
 * - Error recovery
 */
class PortalAgentServiceHyperbrowser {
    constructor() {
        this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        this.hyperbrowser = new Hyperbrowser({
            apiKey: process.env.HYPERBROWSER_API_KEY
        });
        this.session = null;
        this.browser = null;
    }

    /**
     * Create cloud browser session
     */
    async createSession() {
        if (!this.session) {
            console.log('🌐 Creating Hyperbrowser session...');
            this.session = await this.hyperbrowser.sessions.create();
            console.log(`   Session ID: ${this.session.id}`);

            console.log('🔗 Connecting to cloud browser...');
            this.browser = await chromium.connectOverCDP(this.session.wsEndpoint);
            console.log('✅ Connected to Hyperbrowser');
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
            console.log(`   Using: Hyperbrowser (cloud)`);

            const browser = await this.createSession();

            // Hyperbrowser already has a context, use it
            context = browser.contexts()[0];
            page = await context.newPage();

            // Navigate to portal
            await page.goto(portalUrl, { waitUntil: 'networkidle', timeout: 30000 });
            console.log(`✅ Navigated to portal`);

            // Build the instruction for the agent
            const agentKit = new PortalAgentKit({
                page,
                caseData,
                portalUrl,
                dryRun,
                inboxAddress: process.env.REQUESTS_INBOX || 'requests@foib-request.com'
            });

            const instruction = agentKit.buildInstruction();

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
                const pageState = await agentKit.getPageState();

                // Call Claude with vision to decide next action
                // Using Claude Haiku 4.5 - faster and cheaper
                const response = await this.anthropic.messages.create({
                    model: 'claude-haiku-4-5-20251001',
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
                    system: agentKit.getSystemPrompt()
                });

                // Parse agent's decision
                const agentMessage = response.content[0].text;
                console.log(`🧠 Agent thinking: ${agentMessage.substring(0, 200)}...`);

                conversationHistory.push(
                    { role: 'user', content: agentMessage },
                    { role: 'assistant', content: response.content[0].text }
                );

                // Extract and execute action
                const action = agentKit.parseAction(agentMessage);

                if (action.type === 'complete') {
                    console.log(`✅ Agent reports: Task completed!`);
                    completed = true;
                    break;
                }

                if (action.type === 'error') {
                    console.log(`❌ Agent reports: ${action.message}`);
                    throw new Error(action.message);
                }

                // Execute the action (with error handling to save screenshot even on failure)
                let actionResult;
                try {
                    actionResult = await agentKit.executeAction(action);
                } catch (actionError) {
                    // Save screenshot even when action fails
                    stepLog.push({
                        step: currentStep,
                        action: action,
                        result: { error: actionError.message },
                        screenshot: screenshotBase64,
                        url: page.url()
                    });
                    throw actionError; // Re-throw to fail the test
                }

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
                dryRun,
                sessionId: this.session.id
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
                errorScreenshot,
                sessionId: this.session?.id
            };
        } finally {
            if (page) await page.close();
            // Don't close context - Hyperbrowser manages it
        }
    }

    async closeSession() {
        if (this.session) {
            console.log('🛑 Stopping Hyperbrowser session...');
            await this.hyperbrowser.sessions.stop(this.session.id);
            this.session = null;
            this.browser = null;
            console.log('✅ Session stopped');
        }
    }
}

module.exports = new PortalAgentServiceHyperbrowser();
