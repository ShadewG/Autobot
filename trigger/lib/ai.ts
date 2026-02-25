import { createAnthropic } from "@ai-sdk/anthropic";

export const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Easy tasks: fast/cheap model
export const classifyModel = anthropic("claude-haiku-4-5-20251001");
export const classifyOptions = {};

// Hard tasks: strong model for decisions
export const decisionModel = anthropic("claude-sonnet-4-6");
export const decisionOptions = {};

// Draft/research: strong model
export const draftModel = anthropic("claude-sonnet-4-6");
export const draftOptions = {};

export const researchModel = anthropic("claude-sonnet-4-6");
export const researchOptions = {};

// Fallback (same)
export const fallbackDraftModel = anthropic("claude-sonnet-4-6");
