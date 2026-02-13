#!/usr/bin/env node
/**
 * Creates test users, assigns temp cases, and sends a real email from each
 * to verify the per-user FROM address works end-to-end.
 *
 * Usage: node scripts/_test_multi_user_emails.js
 */
require('dotenv').config();

const db = require('../services/database');
const sgMail = require('@sendgrid/mail');

if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const TO_EMAIL = 'shadewofficial@gmail.com';

const TEST_USERS = [
    { name: 'Sam', email_handle: 'sam' },
    { name: 'Alex', email_handle: 'alex' },
    { name: 'Jordan', email_handle: 'jordan' },
];

async function main() {
    console.log('=== Multi-User Email Test ===\n');

    // 1. Ensure migration is applied
    const fs = require('fs');
    try {
        const sql = fs.readFileSync(__dirname + '/../migrations/030_users.sql', 'utf8');
        await db.query(sql);
        console.log('Migration 030 applied (or already exists)\n');
    } catch (e) {
        console.log('Migration note:', e.message.substring(0, 100), '\n');
    }

    const createdUserIds = [];
    const createdCaseIds = [];

    try {
        // 2. Create test users (skip if handle already exists)
        for (const u of TEST_USERS) {
            let user = await db.getUserByHandle(u.email_handle);
            if (!user) {
                user = await db.createUser(u);
                createdUserIds.push(user.id);
                console.log(`Created user: ${user.name} → ${user.email} (id=${user.id})`);
            } else {
                console.log(`User exists: ${user.name} → ${user.email} (id=${user.id})`);
            }
            u.id = user.id;
            u.email = user.email;
        }

        // 3. Create a temp case for each user
        for (const u of TEST_USERS) {
            const fakeNotionId = `test-${u.email_handle}-${Date.now()}`;
            const caseData = await db.query(`
                INSERT INTO cases (notion_page_id, case_name, subject_name, agency_name, agency_email, status, user_id)
                VALUES ($1, $2, $3, $4, $5, 'test', $6)
                RETURNING id
            `, [fakeNotionId, `Test Email - ${u.name}`, 'Test Subject', 'Test Agency', 'test@example.com', u.id]);

            const caseId = caseData.rows[0].id;
            createdCaseIds.push(caseId);
            u.caseId = caseId;
            console.log(`Created temp case #${caseId} for user ${u.name}`);
        }

        console.log('');

        // 4. Send an email for each case using the sendgrid service's getFromEmail logic
        const sendgridService = require('../services/sendgrid-service');

        for (const u of TEST_USERS) {
            const fromEmail = await sendgridService.getFromEmail(u.caseId);
            console.log(`Sending from ${fromEmail} (case #${u.caseId}, user: ${u.name})...`);

            const msg = {
                to: TO_EMAIL,
                from: {
                    email: fromEmail,
                    name: `FOIA Request Team (${u.name})`
                },
                replyTo: fromEmail,
                subject: `[Test] Email from ${u.name} — ${fromEmail}`,
                text: `This is a test email sent from user "${u.name}" with address ${fromEmail}.\n\nCase #${u.caseId}\nTimestamp: ${new Date().toISOString()}`,
                html: `<p>This is a test email sent from user <strong>${u.name}</strong> with address <code>${fromEmail}</code>.</p><p>Case #${u.caseId}<br>Timestamp: ${new Date().toISOString()}</p>`
            };

            try {
                const [response] = await sgMail.send(msg);
                console.log(`  ✅ Sent! Status: ${response.statusCode}, SG ID: ${response.headers['x-message-id']}`);
            } catch (err) {
                console.log(`  ❌ Failed: ${err.message}`);
                if (err.response?.body) {
                    console.log('  SendGrid error:', JSON.stringify(err.response.body.errors || err.response.body));
                }
            }
        }

        // 5. Also send one with no user (default fallback)
        console.log('\nSending from default (no user)...');
        const defaultFrom = await sendgridService.getFromEmail(null);
        console.log(`  FROM: ${defaultFrom}`);

        const defaultMsg = {
            to: TO_EMAIL,
            from: { email: defaultFrom, name: 'FOIA Request Team (Default)' },
            replyTo: defaultFrom,
            subject: `[Test] Email from DEFAULT — ${defaultFrom}`,
            text: `This is a test email from the default address ${defaultFrom}.\nTimestamp: ${new Date().toISOString()}`,
        };

        try {
            const [response] = await sgMail.send(defaultMsg);
            console.log(`  ✅ Sent! Status: ${response.statusCode}`);
        } catch (err) {
            console.log(`  ❌ Failed: ${err.message}`);
            if (err.response?.body) {
                console.log('  SendGrid error:', JSON.stringify(err.response.body.errors || err.response.body));
            }
        }

    } finally {
        // 6. Cleanup temp cases (keep users for monitor testing)
        for (const caseId of createdCaseIds) {
            await db.query('DELETE FROM cases WHERE id = $1', [caseId]);
        }
        console.log(`\nCleaned up ${createdCaseIds.length} temp cases`);
        console.log(`Kept ${TEST_USERS.length} users (sam, alex, jordan) for monitor testing`);
        console.log('\n--- How to test in the monitor ---');
        console.log('1. Open /monitor.html');
        console.log('2. Use the "All Users" dropdown in the top bar to switch between users');
        console.log('3. Open /users.html to manage users');
    }

    await db.close();
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
