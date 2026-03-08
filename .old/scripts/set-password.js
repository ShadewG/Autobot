#!/usr/bin/env node
/**
 * Set a user's password.
 * Usage: node scripts/set-password.js "Sam" "123"
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../services/database');

async function main() {
    const [name, password] = process.argv.slice(2);
    if (!name || !password) {
        console.error('Usage: node scripts/set-password.js <name> <password>');
        process.exit(1);
    }

    await db.initialize();

    const result = await db.query(
        'SELECT id, name FROM users WHERE LOWER(name) = LOWER($1)',
        [name.trim()]
    );
    const user = result.rows[0];
    if (!user) {
        console.error(`User "${name}" not found`);
        await db.close();
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);

    console.log(`Password set for ${user.name} (id=${user.id})`);
    await db.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
