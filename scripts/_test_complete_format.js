require("dotenv").config();
const { wait } = require("@trigger.dev/sdk");

async function main() {
  const apiKey = process.env.TRIGGER_SECRET_KEY;

  // Create fresh token to test output format
  const token = await wait.createToken({
    idempotencyKey: "format-test-" + Date.now(),
    timeout: "5m",
  });
  console.log("Created token:", token.id);

  // Complete via SDK to see what format it uses
  console.log("\nTest: SDK completeToken");
  try {
    const result = await wait.completeToken(token.id, {
      action: "APPROVE",
      instruction: null,
      reason: "test",
    });
    console.log("SDK result:", JSON.stringify(result));
  } catch (e) {
    console.error("SDK failed:", e.message);
  }

  // Now test what the HTTP API expects - try different body formats
  const token2 = await wait.createToken({
    idempotencyKey: "format-test-2-" + Date.now(),
    timeout: "5m",
  });
  console.log("\nCreated token2:", token2.id);

  // Format A: { output: { ... } }
  console.log("\nFormat A: { output: { action: 'APPROVE' } }");
  let resp = await fetch(
    `https://api.trigger.dev/api/v1/waitpoints/tokens/${token2.id}/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        output: { action: "APPROVE", instruction: null, reason: "test" },
      }),
    }
  );
  console.log("Status:", resp.status, "Body:", await resp.text());

  // Create another token
  const token3 = await wait.createToken({
    idempotencyKey: "format-test-3-" + Date.now(),
    timeout: "5m",
  });
  console.log("\nCreated token3:", token3.id);

  // Format B: raw { action: 'APPROVE', ... } as body
  console.log("Format B: { action: 'APPROVE' } directly");
  resp = await fetch(
    `https://api.trigger.dev/api/v1/waitpoints/tokens/${token3.id}/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        action: "APPROVE",
        instruction: null,
        reason: "test",
      }),
    }
  );
  console.log("Status:", resp.status, "Body:", await resp.text());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
