require("dotenv").config();
const { wait } = require("@trigger.dev/sdk");

// Test approving proposals through direct SDK (same as run-engine.js route does)
async function main() {
  const proposals = [
    { id: 286, name: "Springhill PD", token: "waitpoint_cmm1q0dz8jaxy0iog325" },
    { id: 269, name: "Augusta PD", token: "waitpoint_cmm1pv13fjau60hn20v6" },
  ];

  for (const p of proposals) {
    try {
      // This tests the same path as POST /proposals/:id/decision
      await wait.completeToken(p.token, {
        action: "APPROVE",
        instruction: null,
        reason: "Test approval",
      });
      console.log(`Approved: ${p.name} (proposal ${p.id})`);
    } catch (e) {
      console.error(`Failed: ${p.name} - ${e.message}`);
    }
  }

  console.log("\nAll approvals sent. Runs will resume execution.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
