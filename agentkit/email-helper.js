const db = require('../services/database');

class EmailVerificationHelper {
    constructor(options = {}) {
        this.inboxAddress = options.inboxAddress || process.env.REQUESTS_INBOX || 'requests@foib-request.com';
        this.pollIntervalMs = options.pollIntervalMs || 5000;
    }

    /**
     * Wait for a verification email and extract a code using regex
     * @param {Object} params
     * @param {string} params.pattern Regex pattern with a capture group for the code
     * @param {number} params.timeoutMs Max milliseconds to wait
     * @param {string} params.fromEmail Optional sender filter
     * @returns {Promise<string>} Verification code
     */
    async waitForCode({ pattern, timeoutMs = 120000, fromEmail = null }) {
        if (!pattern) {
            throw new Error('Verification pattern is required');
        }

        const regex = new RegExp(pattern, 'i');
        const start = Date.now();
        const since = new Date(start - 60 * 1000); // look back 1 minute by default

        while (Date.now() - start < timeoutMs) {
            const result = await db.query(
                `
                SELECT subject, body_text, body_html, from_email, created_at
                FROM messages
                WHERE direction = 'inbound'
                    AND to_email = $1
                    AND created_at >= $2
                ORDER BY created_at DESC
                LIMIT 25
                `,
                [this.inboxAddress, since]
            );

            for (const row of result.rows) {
                if (fromEmail && row.from_email && !row.from_email.toLowerCase().includes(fromEmail.toLowerCase())) {
                    continue;
                }

                const haystacks = [
                    row.subject || '',
                    row.body_text || '',
                    row.body_html || ''
                ];

                for (const haystack of haystacks) {
                    const match = haystack.match(regex);
                    if (match && match[1]) {
                        console.log(`📬 Verification code received from ${row.from_email || 'unknown sender'}`);
                        return match[1].trim();
                    }
                }
            }

            await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }

        throw new Error('Timed out waiting for verification code email');
    }
}

module.exports = EmailVerificationHelper;
