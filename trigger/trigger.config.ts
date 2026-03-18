import { defineConfig } from "@trigger.dev/sdk";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

const exporters: any[] = [];
if (process.env.BRAINTRUST_API_KEY) {
  try {
    const { BraintrustExporter } = require("@braintrust/otel");
    exporters.push(
      new BraintrustExporter({
        parent: "project_name:Autobot",
        filterAISpans: true,
      })
    );
  } catch (_) {}
}

export default defineConfig({
  project: "proj_afwkrlynxcczbgflspqf",
  runtime: "node",
  logLevel: "log",
  maxDuration: 300,
  telemetry: {
    exporters,
  },
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
      "playwright",
      "playwright-core",
      "chromium-bidi",
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
          "FIRECRAWL_API_KEY",
          "PARALLEL_API_KEY",
          "BRAINTRUST_API_KEY",
          "PORTAL_PRIMARY_ENGINE",
          "BROWSERBASE_API_KEY",
          "BROWSERBASE_PROJECT_ID",
          "PLAYWRIGHT_BROWSER_BACKEND",
          "BROWSERBASE_REGION",
          "BROWSERBASE_ADVANCED_STEALTH",
          "BROWSERBASE_SOLVE_CAPTCHAS",
          "BROWSERBASE_PROXIES",
          "BROWSERBASE_PROXY_PROVIDERS",
          "BROWSERBASE_PROXY_DOMAINS",
          "BROWSERBASE_PROXY_COUNTRY",
          "BROWSERBASE_AUTH_CONTEXT_PROVIDERS",
          "TWOCAPTCHA_API_KEY",
          "PLAYWRIGHT_CHROME_PATH",
          "PLAYWRIGHT_CAPTCHA_SOLVING",
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
