require("dotenv").config();
const { wait } = require("@trigger.dev/sdk");

async function main() {
  const token = "waitpoint_cmm1q0dz8jaxy0iog325"; // Springhill PD

  try {
    console.log("Attempting completeToken with:", token);
    const result = await wait.completeToken(token, {
      action: "APPROVE",
      instruction: null,
      reason: "Test approval",
    });
    console.log("Success:", result);
  } catch (e) {
    console.error("Error name:", e.name);
    console.error("Error message:", e.message);
    console.error("Error status:", e.status);
    console.error("Error headers:", JSON.stringify(e.headers || {}));
    if (e.body) console.error("Error body:", JSON.stringify(e.body));
    if (e.cause) console.error("Error cause:", e.cause);
    console.error("Full error:", JSON.stringify(e, Object.getOwnPropertyNames(e)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
