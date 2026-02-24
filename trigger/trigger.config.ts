import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "autobot-mvp",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  dirs: ["./tasks", "./steps"],
});
