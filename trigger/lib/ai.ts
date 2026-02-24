import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Default models
export const classifyModel = openai("gpt-4o");
export const draftModel = openai("gpt-4o");
export const researchModel = openai("gpt-4o");
export const fallbackDraftModel = anthropic("claude-sonnet-4-20250514");
