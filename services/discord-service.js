const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

/**
 * Discord Notification Service
 * Sends real-time notifications for all bot activities
 */
class DiscordService {
    constructor() {
        this.client = null;
        this.channelId = process.env.DISCORD_CHANNEL_ID || '1437788098380435519';
        this.enabled = !!process.env.DISCORD_TOKEN;
        this.ready = false;
    }

    /**
     * Initialize Discord client
     */
    async initialize() {
        if (!this.enabled) {
            console.log('ℹ️  Discord notifications disabled (no DISCORD_TOKEN)');
            return;
        }

        try {
            this.client = new Client({
                intents: [GatewayIntentBits.Guilds]
            });

            this.client.once('ready', () => {
                console.log(`✅ Discord bot connected as ${this.client.user.tag}`);
                this.ready = true;
            });

            await this.client.login(process.env.DISCORD_TOKEN);
        } catch (error) {
            console.error('❌ Failed to initialize Discord:', error.message);
            this.enabled = false;
        }
    }

    /**
     * Send a notification to Discord
     */
    async notify(options) {
        if (!this.enabled || !this.ready) return;

        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) {
                console.error('Discord channel not found');
                return;
            }

            const { title, description, color, fields } = options;

            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .setColor(color || 0x667eea)
                .setTimestamp();

            if (fields && fields.length > 0) {
                embed.addFields(fields);
            }

            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Discord notification error:', error.message);
        }
    }

    /**
     * Notify when a request is sent
     */
    async notifyRequestSent(caseData, method) {
        await this.notify({
            title: '📤 Request Sent',
            description: `Sent FOIA request for **${caseData.case_name || 'Case #' + caseData.id}**`,
            color: 0x48bb78, // Green
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Agency', value: caseData.agency_name || 'Unknown', inline: true },
                { name: 'Method', value: method === 'portal' ? '🌐 Portal' : '📧 Email', inline: true },
                { name: 'State', value: caseData.state || 'N/A', inline: true }
            ]
        });
    }

    /**
     * Notify when a response is received
     */
    async notifyResponseReceived(caseData, analysis) {
        const intentEmoji = {
            acknowledgment: '👍',
            fee_notice: '💰',
            denial: '❌',
            approval: '✅',
            request_info: '❓',
            delivery: '📦'
        };

        await this.notify({
            title: '📨 Response Received',
            description: `Received response for **${caseData.case_name || 'Case #' + caseData.id}**`,
            color: 0x4299e1, // Blue
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Agency', value: caseData.agency_name || 'Unknown', inline: true },
                { name: 'Intent', value: `${intentEmoji[analysis.intent] || '📋'} ${analysis.intent}`, inline: true },
                { name: 'Sentiment', value: analysis.sentiment || 'neutral', inline: true }
            ]
        });
    }

    /**
     * Notify when auto-reply is sent
     */
    async notifyAutoReplySent(caseData, replyType) {
        await this.notify({
            title: '🤖 Auto-Reply Sent',
            description: `Sent automatic reply for **${caseData.case_name || 'Case #' + caseData.id}**`,
            color: 0x9f7aea, // Purple
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Agency', value: caseData.agency_name || 'Unknown', inline: true },
                { name: 'Type', value: replyType || 'Standard', inline: true }
            ]
        });
    }

    /**
     * Notify when portal submission happens
     */
    async notifyPortalSubmission(caseData, result) {
        await this.notify({
            title: '🌐 Portal Submission',
            description: `Portal submission for **${caseData.case_name || 'Case #' + caseData.id}**`,
            color: result.success ? 0x48bb78 : 0xf56565,
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Status', value: result.success ? '✅ Success' : '❌ Failed', inline: true },
                { name: 'Portal', value: result.portalUrl || 'Unknown', inline: false },
                { name: 'Steps', value: `${result.steps || 0}`, inline: true },
                { name: 'Engine', value: 'Skyvern', inline: true }
            ]
        });
    }

    /**
     * Notify when case needs human review
     */
    async notifyHumanReview(caseData, reason) {
        await this.notify({
            title: '⚠️ Human Review Required',
            description: `**${caseData.case_name || 'Case #' + caseData.id}** needs your attention`,
            color: 0xed8936, // Orange
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Agency', value: caseData.agency_name || 'Unknown', inline: true },
                { name: 'Reason', value: reason, inline: false }
            ]
        });
    }

    /**
     * Notify when a response gets stuck without analysis
     */
    async notifyStuckResponse(caseData, hoursStuck) {
        await this.notify({
            title: '🚨 Stuck Response Detected',
            description: `**${caseData.case_name || 'Case #' + caseData.id}** has been stuck in "responded" status`,
            color: 0xf56565, // Red
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Hours Stuck', value: `${hoursStuck}h`, inline: true },
                { name: 'Agency', value: caseData.agency_name || 'Unknown', inline: false },
                { name: 'Action', value: 'Auto-flagged for human review', inline: false }
            ]
        });
    }

    /**
     * Notify when case is escalated
     */
    async notifyEscalation(caseData, escalationReason, urgency) {
        await this.notify({
            title: '🚨 Case Escalated',
            description: `**${caseData.case_name || 'Case #' + caseData.id}** has been escalated`,
            color: 0xf56565, // Red
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Urgency', value: urgency.toUpperCase(), inline: true },
                { name: 'Reason', value: escalationReason, inline: false }
            ]
        });
    }

    /**
     * Notify when follow-up is sent
     */
    async notifyFollowUpSent(caseData, followUpCount) {
        await this.notify({
            title: '🔔 Follow-Up Sent',
            description: `Follow-up #${followUpCount} sent for **${caseData.case_name || 'Case #' + caseData.id}**`,
            color: 0xfbbf24, // Yellow
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Agency', value: caseData.agency_name || 'Unknown', inline: true },
                { name: 'Follow-Up #', value: `${followUpCount}`, inline: true }
            ]
        });
    }

    /**
     * Notify when fee response needs approval
     */
    async notifyFeeApprovalNeeded(caseData, feeAmount) {
        await this.notify({
            title: '💰 Fee Response Needs Approval',
            description: `Agency quoted **$${feeAmount}** for **${caseData.case_name || 'Case #' + caseData.id}**`,
            color: 0xfbbf24, // Yellow
            fields: [
                { name: 'Case ID', value: `#${caseData.id}`, inline: true },
                { name: 'Agency', value: caseData.agency_name || 'Unknown', inline: true },
                { name: 'Fee Amount', value: `$${feeAmount}`, inline: true }
            ]
        });
    }

    /**
     * Notify on errors
     */
    async notifyError(operation, error, caseId = null) {
        await this.notify({
            title: '❌ Error',
            description: `Error during **${operation}**`,
            color: 0xf56565, // Red
            fields: [
                { name: 'Error', value: error.message || 'Unknown error', inline: false },
                ...(caseId ? [{ name: 'Case ID', value: `#${caseId}`, inline: true }] : [])
            ]
        });
    }

    /**
     * Notify bulk sync
     */
    async notifyBulkSync(syncedCount, queuedCount, reviewCount) {
        await this.notify({
            title: '🔄 Notion Sync Complete',
            description: `Synced ${syncedCount} cases from Notion`,
            color: 0x667eea, // Purple
            fields: [
                { name: '📤 Queued', value: `${queuedCount}`, inline: true },
                { name: '⚠️ Review', value: `${reviewCount}`, inline: true },
                { name: '📊 Total', value: `${syncedCount}`, inline: true }
            ]
        });
    }
}

module.exports = new DiscordService();
