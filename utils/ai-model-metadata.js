function toNumberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function buildModelMetadata({ response = null, usage = null, modelId = null, startedAt = null, finishedAt = Date.now() } = {}) {
  const normalizedUsage = usage || {};
  const promptTokens =
    normalizedUsage.promptTokens ??
    normalizedUsage.inputTokens ??
    normalizedUsage.prompt_tokens ??
    normalizedUsage.input_tokens ??
    null;
  const completionTokens =
    normalizedUsage.completionTokens ??
    normalizedUsage.outputTokens ??
    normalizedUsage.completion_tokens ??
    normalizedUsage.output_tokens ??
    null;

  return {
    modelId: response?.modelId || response?.model || modelId || null,
    promptTokens: toNumberOrNull(promptTokens),
    completionTokens: toNumberOrNull(completionTokens),
    latencyMs: startedAt ? Math.max(0, finishedAt - startedAt) : null,
  };
}

module.exports = {
  buildModelMetadata,
};
