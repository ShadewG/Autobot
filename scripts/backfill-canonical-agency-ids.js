#!/usr/bin/env node

require('dotenv').config();

const db = require('../services/database');

function parseArgs(argv) {
  const args = { dryRun: true, limit: 500, caseIds: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--limit' && argv[i + 1]) {
      args.limit = parseInt(argv[++i], 10);
    } else if (arg === '--case-ids' && argv[i + 1]) {
      args.caseIds = argv[++i]
        .split(',')
        .map((value) => parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0);
    }
  }
  return args;
}

async function main() {
  const options = parseArgs(process.argv);
  const result = await db.backfillCanonicalAgencyIds(options);
  console.log(JSON.stringify(result, null, 2));
  await db.pool.end();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await db.pool.end();
  } catch (_) {
    // ignore close failures on fatal path
  }
  process.exit(1);
});
