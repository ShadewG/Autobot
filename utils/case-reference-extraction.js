function extractReferencedCaseId(...chunks) {
  const text = chunks
    .filter(Boolean)
    .map((chunk) => String(chunk))
    .join('\n');

  if (!text) return null;

  const patterns = [
    /\bcase\s*(?:id|#)\s*(?:is|:|#)?\s*(\d{3,})\b/i,
    /\bcase\s+number\s*(?:is|:|#)?\s*(\d{3,})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

module.exports = {
  extractReferencedCaseId,
};
