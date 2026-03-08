require("dotenv").config();
const { wait } = require("@trigger.dev/sdk");

async function main() {
  const tokenId = "waitpoint_cmm1q0dz8jaxy0iog325"; // Springhill PD
  const output = {
    action: "APPROVE",
    instruction: null,
    reason: "Test approval",
  };

  // Attempt 1: Object format { id: tokenId }
  console.log("Attempt 1: Object format { id: tokenId }");
  try {
    const result = await wait.completeToken({ id: tokenId }, output);
    console.log("Success:", JSON.stringify(result));
    return;
  } catch (e) {
    console.error("Failed:", e.message, "status:", e.status);
  }

  // Attempt 2: Direct HTTP POST to the completion URL
  console.log("\nAttempt 2: Direct HTTP POST");
  const apiKey = process.env.TRIGGER_SECRET_KEY;
  try {
    const resp = await fetch(
      `https://api.trigger.dev/api/v1/waitpoints/tokens/${tokenId}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ output }),
      }
    );
    const body = await resp.text();
    console.log("Status:", resp.status, "Body:", body);
  } catch (e) {
    console.error("HTTP failed:", e.message);
  }

  // Attempt 3: Try the URL format from docs
  console.log("\nAttempt 3: POST to /wait/complete/:id");
  try {
    const resp = await fetch(
      `https://api.trigger.dev/wait/complete/${tokenId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(output),
      }
    );
    const body = await resp.text();
    console.log("Status:", resp.status, "Body:", body);
  } catch (e) {
    console.error("HTTP failed:", e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
