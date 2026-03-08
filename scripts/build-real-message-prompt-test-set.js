#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const promptPatternDatasetService = require('../services/prompt-pattern-dataset-service');

function parseArg(flag, defaultValue) {
  const entry = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (!entry) return defaultValue;
  return entry.slice(flag.length + 1);
}

async function main() {
  const sinceDays = parseInt(parseArg('--since-days', '365'), 10);
  const limit = parseInt(parseArg('--limit', '500'), 10);
  const perPattern = parseInt(parseArg('--per-pattern', '12'), 10);
  const outputPath = parseArg(
    '--output',
    path.join(__dirname, '../tests/fixtures/inbound/real-message-patterns.json')
  );

  const dataset = await promptPatternDatasetService.buildPromptPatternDataset({
    sinceDays,
    limit,
    perPattern,
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2));

  console.log(`Wrote prompt pattern dataset to ${outputPath}`);
  for (const [pattern, count] of Object.entries(dataset.counts)) {
    console.log(`${pattern}: ${count}`);
  }
}

main().catch((error) => {
  console.error('Failed to build prompt pattern dataset:', error);
  process.exit(1);
});
