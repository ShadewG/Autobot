const Anthropic = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');
const PortalAgentKit = require('../agentkit/portal-agent-kit');

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
                const response = await this.anthropic.messages.create({
                    model: 'claude-3-5-sonnet-20240620',
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

                // Execute the action
                const actionResult = await agentKit.executeAction(action);

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

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

module.exports = new PortalAgentService();
