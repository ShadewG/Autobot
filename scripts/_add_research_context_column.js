/**
 * DB Migration: Add research_context_jsonb column to cases table
 * Run with: node scripts/_add_research_context_column.js
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE cases ADD COLUMN IF NOT EXISTS research_context_jsonb JSONB DEFAULT NULL;
    `);
    console.log('Migration complete: research_context_jsonb column added to cases table');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
