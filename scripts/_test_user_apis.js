#!/usr/bin/env node
/**
 * Quick smoke test for user API endpoints.
 * Run: node scripts/_test_user_apis.js
 */
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const db = require('../services/database');
const userRoutes = require('../routes/users');
const monitorRoutes = require('../routes/monitor');

app.use('/api/users', userRoutes);
app.use('/api/monitor', monitorRoutes);

const PORT = 3999;

async function run() {
    // Run migration
    try {
        const fs = require('fs');
        const sql = fs.readFileSync(__dirname + '/../migrations/030_users.sql', 'utf8');
        await db.query(sql);
        console.log('Migration applied (or already exists)');
    } catch (e) {
        console.log('Migration note:', e.message.substring(0, 120));
    }

    const server = app.listen(PORT, async () => {
        console.log(`Test server on ${PORT}\n`);
        let testUserId = null;
        const results = [];

        function log(name, status, ok, extra) {
            const pass = ok ? '✅' : '❌';
            const line = `${pass} ${name}: ${status} ${extra || ''}`;
            console.log(line);
            results.push({ name, pass: ok });
        }

        try {
            // 1. GET /api/users
            let res = await fetch(`http://localhost:${PORT}/api/users`);
            let data = await res.json();
            log('GET /api/users', res.status, data.success, `users: ${data.users?.length}`);

            // 2. POST /api/users (create)
            res = await fetch(`http://localhost:${PORT}/api/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Test User', email_handle: 'test-api-check' })
            });
            data = await res.json();
            log('POST /api/users', res.status, data.success && res.status === 201, `email: ${data.user?.email}`);
            testUserId = data.user?.id;

            // 3. GET /api/users/:id
            if (testUserId) {
                res = await fetch(`http://localhost:${PORT}/api/users/${testUserId}`);
                data = await res.json();
                log('GET /api/users/:id', res.status, data.success, `name: ${data.user?.name}, case_count: ${data.user?.case_count}`);
            }

            // 4. PATCH /api/users/:id
            if (testUserId) {
                res = await fetch(`http://localhost:${PORT}/api/users/${testUserId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Updated User' })
                });
                data = await res.json();
                log('PATCH /api/users/:id', res.status, data.success && data.user?.name === 'Updated User', `name: ${data.user?.name}`);
            }

            // 5. POST duplicate handle (should 409)
            res = await fetch(`http://localhost:${PORT}/api/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Dupe', email_handle: 'test-api-check' })
            });
            data = await res.json();
            log('POST duplicate handle', res.status, res.status === 409, data.error);

            // 6. POST invalid handle (should 400)
            res = await fetch(`http://localhost:${PORT}/api/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Bad', email_handle: 'A' })
            });
            data = await res.json();
            log('POST invalid handle', res.status, res.status === 400, data.error);

            // 7. POST missing name (should 400)
            res = await fetch(`http://localhost:${PORT}/api/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email_handle: 'good-handle' })
            });
            data = await res.json();
            log('POST missing name', res.status, res.status === 400, data.error);

            // 8. GET /api/monitor/cases (all, no filter)
            res = await fetch(`http://localhost:${PORT}/api/monitor/cases?limit=3`);
            data = await res.json();
            const hasUserFields = data.cases && data.cases.length > 0
                ? 'user_handle' in data.cases[0]
                : 'no cases to check';
            log('GET /api/monitor/cases (all)', res.status, data.success, `count: ${data.count}, user_handle field: ${hasUserFields}`);

            // 9. GET /api/monitor/cases?user_id=unowned
            res = await fetch(`http://localhost:${PORT}/api/monitor/cases?limit=3&user_id=unowned`);
            data = await res.json();
            log('GET /cases?user_id=unowned', res.status, data.success, `count: ${data.count}`);

            // 10. GET /api/monitor/cases?user_id=<testUserId>
            if (testUserId) {
                res = await fetch(`http://localhost:${PORT}/api/monitor/cases?limit=3&user_id=${testUserId}`);
                data = await res.json();
                log('GET /cases?user_id=N', res.status, data.success, `count: ${data.count} (expected 0 for new user)`);
            }

            // 11. GET /api/monitor/cases?user_id=999 (non-existent)
            res = await fetch(`http://localhost:${PORT}/api/monitor/cases?limit=3&user_id=999`);
            data = await res.json();
            log('GET /cases?user_id=999', res.status, data.success, `count: ${data.count}`);

            // 12. DELETE /api/users/:id (soft delete)
            if (testUserId) {
                res = await fetch(`http://localhost:${PORT}/api/users/${testUserId}`, { method: 'DELETE' });
                data = await res.json();
                log('DELETE /api/users/:id', res.status, data.success && data.user?.active === false, `active: ${data.user?.active}`);
            }

            // 13. GET /api/users?active=false (should include deactivated)
            res = await fetch(`http://localhost:${PORT}/api/users?active=false`);
            data = await res.json();
            const hasDeactivated = data.users?.some(u => u.email_handle === 'test-api-check' && !u.active);
            log('GET /api/users?active=false', res.status, data.success && hasDeactivated, `includes deactivated: ${hasDeactivated}`);

            // 14. GET non-existent user (should 404)
            res = await fetch(`http://localhost:${PORT}/api/users/99999`);
            data = await res.json();
            log('GET /api/users/99999', res.status, res.status === 404, data.error);

        } catch (e) {
            console.error('\nTest error:', e);
        }

        // Cleanup
        if (testUserId) {
            await db.query('DELETE FROM users WHERE id = $1', [testUserId]);
            console.log('\nCleaned up test user');
        }

        // Summary
        const passed = results.filter(r => r.pass).length;
        const failed = results.filter(r => !r.pass).length;
        console.log(`\n========================================`);
        console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length}`);
        console.log(`========================================`);

        server.close();
        await db.close();
        process.exit(failed > 0 ? 1 : 0);
    });
}

run();
