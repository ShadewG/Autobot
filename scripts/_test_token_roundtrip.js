require("dotenv").config();
const { wait } = require("@trigger.dev/sdk");

async function main() {
  // Test 1: Create a fresh token and complete it
  console.log("Test 1: Create fresh token and complete it");
  try {
    const token = await wait.createToken({
      idempotencyKey: "test-roundtrip-" + Date.now(),
      timeout: "5m",
    });
    console.log("Created token:", token.id, "isCached:", token.isCached);

    const result = await wait.completeToken(token.id, { test: true });
    console.log("Completed successfully:", JSON.stringify(result));
  } catch (e) {
    console.error("Failed:", e.message, "status:", e.status);
  }

  // Test 2: Try to retrieve token info before completing
  console.log("\nTest 2: Retrieve one of the WAITING tokens");
  const waitingToken = "waitpoint_cmm1q0dz8jaxy0iog325";
  try {
    // Try createToken with the same idempotencyKey to get cached version
    // We don't know the original idempotencyKey... check DB
    const token = await wait.createToken({
      idempotencyKey: waitingToken,
      timeout: "30d",
    });
    console.log("Got token:", token.id, "isCached:", token.isCached);

    // If we got a NEW token (isCached=false), the original is gone
    if (token.isCached) {
      console.log("Token is cached - trying to complete via cached ID:", token.id);
      const result = await wait.completeToken(token.id, {
        action: "APPROVE",
        instruction: null,
        reason: "Test approval",
      });
      console.log("Completed:", JSON.stringify(result));
    } else {
      console.log(
        "Got a NEW token (not cached) - the idempotencyKey didn't match"
      );
      console.log("New token ID:", token.id);
    }
  } catch (e) {
    console.error("Failed:", e.message, "status:", e.status);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
