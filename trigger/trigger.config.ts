import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_afwkrlynxcczbgflspqf",
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
  build: {
    external: [
      "canvas",
      "pdf.js-extract",
      "bullmq",
      "ioredis",
    ],
    extensions: [
      syncEnvVars(async () => {
        // Sync env vars from the CLI process into the Trigger.dev deploy
        const vars = [
          "OPENAI_API_KEY",
          "DATABASE_URL",
          "SENDGRID_API_KEY",
          "SENDGRID_FROM_EMAIL",
          "SENDGRID_FROM_NAME",
          "RAILWAY_STATIC_URL",
        ];
        return vars
          .filter((name) => process.env[name])
          .map((name) => ({ name, value: process.env[name]! }));
      }),
    ],
  },
});
