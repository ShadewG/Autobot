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
          "ANTHROPIC_API_KEY",
          "SENDGRID_API_KEY",
          "SENDGRID_FROM_EMAIL",
          "SENDGRID_FROM_NAME",
          "RAILWAY_STATIC_URL",
          "SKYVERN_API_KEY",
          "SKYVERN_API_URL",
          "SKYVERN_WORKFLOW_ID",
          "SKYVERN_WORKFLOW_RUN_URL",
          "SKYVERN_WORKFLOW_STATUS_URL",
          "SKYVERN_APP_BASE_URL",
          "SKYVERN_PROXY_LOCATION",
          "REQUESTS_INBOX",
          "AI_ROUTER_V2",
        ];
        const result = vars
          .filter((name) => process.env[name])
          .map((name) => ({ name, value: process.env[name]! }));

        // Use DATABASE_PUBLIC_URL for Trigger.dev (runs outside Railway network)
        const dbUrl = process.env["DATABASE_PUBLIC_URL"] || process.env["DATABASE_URL"];
        if (dbUrl) {
          result.push({ name: "DATABASE_URL", value: dbUrl });
        }

        return result;
      }),
    ],
  },
});
