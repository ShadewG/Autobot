const TRANSIENT_ERROR_PATTERNS = [
  /too many clients/i,
  /connection\s*(?:timed?\s*out|reset|refused|terminated)/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /53300/, // PostgreSQL too many clients
  /57P01/, // PostgreSQL admin shutdown
  /08006/, // PostgreSQL connection failure
];

export function isTransientError(error: unknown): boolean {
  const msg = String(error || "");
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
}
