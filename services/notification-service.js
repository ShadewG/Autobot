const axios = require('axios');
const notionService = require('./notion-service');

/**
 * Notification Service
 *
 * Sends notifications for important events like:
 * - Agent escalations (needs human review)
 * - High-value fee notices
 * - Denials that need legal review
 * - Cases approaching deadlines
 */
class NotificationService {
    constructor() {
        this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
        this.notificationsEnabled = process.env.ENABLE_NOTIFICATIONS === 'true';
    }

    /**
     * Send escalation notification
     */
    async notifyEscalation({ case_id, case_name, agency_name, reason, urgency, suggested_action }) {
        if (!this.notificationsEnabled) {
            console.log('ℹ️  Notifications disabled, skipping escalation alert');
            return;
        }

        console.log(`\n📢 Sending escalation notification:`);
        console.log(`   Case: ${case_name}`);
        console.log(`   Agency: ${agency_name}`);
        console.log(`   Urgency: ${urgency}`);
        console.log(`   Reason: ${reason}`);

        // Send to Discord if webhook is configured
        if (this.discordWebhookUrl) {
            await this.sendDiscordEscalation({
                case_id,
                case_name,
                agency_name,
                reason,
                urgency,
                suggested_action
            });
        }

        // Sync status to Notion
        try {
            await notionService.syncStatusToNotion(case_id);
        } catch (error) {
            console.error('Failed to sync Notion status:', error.message);
        }
    }

    /**
     * Send Discord notification via webhook
     */
    async sendDiscordEscalation({ case_id, case_name, agency_name, reason, urgency, suggested_action }) {
        try {
            const urgencyEmoji = {
                'high': '🚨',
                'medium': '⚠️',
                'low': 'ℹ️'
            }[urgency] || '⚠️';

            const urgencyColor = {
                'high': 15158332,  // Red
                'medium': 16776960, // Yellow
                'low': 3447003     // Blue
            }[urgency] || 16776960;

            const embed = {
                title: `${urgencyEmoji} FOIA Case Escalation`,
                description: `Case #${case_id} needs human review`,
                color: urgencyColor,
                fields: [
                    {
                        name: 'Case Name',
                        value: case_name || 'Unnamed case',
                        inline: false
                    },
                    {
                        name: 'Agency',
                        value: agency_name || 'Unknown',
                        inline: true
                    },
                    {
                        name: 'Urgency',
                        value: urgency.toUpperCase(),
                        inline: true
                    },
                    {
                        name: 'Reason',
                        value: reason,
                        inline: false
                    }
                ],
                timestamp: new Date().toISOString()
            };

            if (suggested_action) {
                embed.fields.push({
                    name: '💡 Suggested Action',
                    value: suggested_action,
                    inline: false
                });
            }

            // Add link to Railway dashboard
            const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN;
            if (railwayUrl) {
                embed.fields.push({
                    name: '🔗 View Case',
                    value: `${railwayUrl}/api/cases/${case_id}`,
                    inline: false
                });
            }

            await axios.post(this.discordWebhookUrl, {
                embeds: [embed]
            });

            console.log('✅ Discord notification sent');
        } catch (error) {
            console.error('❌ Failed to send Discord notification:', error.message);
        }
    }

    /**
     * Send notification for high-value fee
     */
    async notifyHighFee({ case_id, case_name, agency_name, fee_amount }) {
        if (!this.notificationsEnabled || !this.discordWebhookUrl) {
            return;
        }

        try {
            const embed = {
                title: '💰 High Fee Notice',
                description: `Agency requesting $${fee_amount} for records`,
                color: 16776960, // Yellow
                fields: [
                    {
                        name: 'Case',
                        value: case_name,
                        inline: false
                    },
                    {
                        name: 'Agency',
                        value: agency_name,
                        inline: true
                    },
                    {
                        name: 'Fee Amount',
                        value: `$${fee_amount}`,
                        inline: true
                    },
                    {
                        name: 'Action Required',
                        value: 'Review fee and decide whether to pay or negotiate',
                        inline: false
                    }
                ],
                timestamp: new Date().toISOString()
            };

            await axios.post(this.discordWebhookUrl, {
                embeds: [embed]
            });

            console.log('✅ High fee notification sent');
        } catch (error) {
            console.error('❌ Failed to send fee notification:', error.message);
        }
    }

    /**
     * Send notification for approaching deadline
     */
    async notifyDeadline({ case_id, case_name, agency_name, deadline, days_remaining }) {
        if (!this.notificationsEnabled || !this.discordWebhookUrl) {
            return;
        }

        try {
            const urgency = days_remaining <= 2 ? 'high' : days_remaining <= 5 ? 'medium' : 'low';
            const urgencyEmoji = urgency === 'high' ? '🚨' : urgency === 'medium' ? '⚠️' : 'ℹ️';

            const embed = {
                title: `${urgencyEmoji} FOIA Deadline Approaching`,
                description: `${days_remaining} day(s) until deadline`,
                color: urgency === 'high' ? 15158332 : 16776960,
                fields: [
                    {
                        name: 'Case',
                        value: case_name,
                        inline: false
                    },
                    {
                        name: 'Agency',
                        value: agency_name,
                        inline: true
                    },
                    {
                        name: 'Deadline',
                        value: new Date(deadline).toLocaleDateString(),
                        inline: true
                    },
                    {
                        name: 'Days Remaining',
                        value: days_remaining.toString(),
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString()
            };

            await axios.post(this.discordWebhookUrl, {
                embeds: [embed]
            });

            console.log('✅ Deadline notification sent');
        } catch (error) {
            console.error('❌ Failed to send deadline notification:', error.message);
        }
    }

    /**
     * Send notification for successful records delivery
     */
    async notifySuccess({ case_id, case_name, agency_name }) {
        if (!this.notificationsEnabled || !this.discordWebhookUrl) {
            return;
        }

        try {
            const embed = {
                title: '🎉 Records Delivered!',
                description: `Agency approved request and delivered records`,
                color: 3066993, // Green
                fields: [
                    {
                        name: 'Case',
                        value: case_name,
                        inline: false
                    },
                    {
                        name: 'Agency',
                        value: agency_name,
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString()
            };

            await axios.post(this.discordWebhookUrl, {
                embeds: [embed]
            });

            console.log('✅ Success notification sent');
        } catch (error) {
            console.error('❌ Failed to send success notification:', error.message);
        }
    }

    /**
     * Send daily summary
     */
    async sendDailySummary({ total_cases, pending, sent, approved, denied, needs_review }) {
        if (!this.notificationsEnabled || !this.discordWebhookUrl) {
            return;
        }

        try {
            const embed = {
                title: '📊 Daily FOIA Summary',
                description: `Status update for ${new Date().toLocaleDateString()}`,
                color: 3447003, // Blue
                fields: [
                    {
                        name: 'Total Active Cases',
                        value: total_cases.toString(),
                        inline: true
                    },
                    {
                        name: 'Pending',
                        value: pending.toString(),
                        inline: true
                    },
                    {
                        name: 'Sent',
                        value: sent.toString(),
                        inline: true
                    },
                    {
                        name: '✅ Approved',
                        value: approved.toString(),
                        inline: true
                    },
                    {
                        name: '❌ Denied',
                        value: denied.toString(),
                        inline: true
                    },
                    {
                        name: '👀 Needs Review',
                        value: needs_review.toString(),
                        inline: true
                    }
                ],
                timestamp: new Date().toISOString()
            };

            await axios.post(this.discordWebhookUrl, {
                embeds: [embed]
            });

            console.log('✅ Daily summary sent');
        } catch (error) {
            console.error('❌ Failed to send daily summary:', error.message);
        }
    }
}

module.exports = new NotificationService();
