require("dotenv").config();
const { wait } = require("@trigger.dev/sdk");
const { Client } = require("pg");

async function main() {
  const c = new Client(
    "postgresql://postgres:EsoRieVyRUVqLZEaGcecTqCDALRGxXXH@switchback.proxy.rlwy.net:39529/railway"
  );
  await c.connect();

  // Get the original UUID idempotencyKeys used by gate-or-execute
  // They were passed to waitForHumanDecision which used them as idempotencyKey for createToken
  // But DB now has the real token ID. We need the original UUID.
  // Let's check proposal_key to reverse-engineer the flow

  const { rows } = await c.query(`
    SELECT id, case_id, proposal_key, action_type, status, waitpoint_token,
           updated_at
    FROM proposals
    WHERE waitpoint_token IS NOT NULL
      AND status = 'PENDING_APPROVAL'
      AND updated_at > NOW() - interval '1 hour'
    ORDER BY updated_at DESC
  `);

  console.log("PENDING_APPROVAL proposals with tokens:");
  for (const p of rows) {
    console.log(
      `  Proposal ${p.id} | case ${p.case_id} | ${p.action_type} | token: ${p.waitpoint_token}`
    );
  }

  // The real token is stored in DB. Let's try the direct HTTP approach with more debugging
  const apiKey = process.env.TRIGGER_SECRET_KEY;

  for (const p of rows) {
    const tokenId = p.waitpoint_token;
    console.log(`\nTrying to complete token: ${tokenId}`);

    // Try the /api/v2 endpoint
    const urls = [
      `https://api.trigger.dev/api/v1/waitpoints/tokens/${tokenId}/complete`,
      `https://api.trigger.dev/api/v2/waitpoints/tokens/${tokenId}/complete`,
      `https://api.trigger.dev/api/v3/waitpoints/tokens/${tokenId}/complete`,
    ];

    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            output: { action: "APPROVE", instruction: null, reason: "test" },
          }),
        });
        const body = await resp.text();
        console.log(`  ${url.split("trigger.dev")[1]} -> ${resp.status}: ${body.substring(0, 200)}`);
      } catch (e) {
        console.log(`  ${url} -> Error: ${e.message}`);
      }
    }
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
