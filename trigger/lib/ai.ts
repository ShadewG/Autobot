import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const GPT_5_2 = "gpt-5.2-2025-12-11";

// Easy tasks: low reasoning effort
export const classifyModel = openai(GPT_5_2);
export const classifyOptions = { openai: { reasoningEffort: "low" as const } };

// Hard tasks: medium reasoning effort
export const decisionModel = openai(GPT_5_2);
export const decisionOptions = { openai: { reasoningEffort: "medium" as const } };

// Draft/research (medium reasoning effort)
export const draftModel = openai(GPT_5_2);
export const draftOptions = { openai: { reasoningEffort: "medium" as const } };

export const researchModel = openai(GPT_5_2);
export const researchOptions = { openai: { reasoningEffort: "medium" as const } };

// Fallback
export const fallbackDraftModel = anthropic("claude-sonnet-4-20250514");
