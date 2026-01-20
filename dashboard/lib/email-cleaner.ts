/**
 * Email body cleaner utility
 * Removes common email boilerplate like:
 * - CAUTION/WARNING blocks
 * - CONFIDENTIALITY NOTICE footers
 * - Quoted reply chains
 * - External email warnings
 */

export function cleanEmailBody(rawBody: string): string {
  if (!rawBody) return '';

  let cleaned = rawBody;

  // Remove CAUTION/WARNING blocks (multi-line)
  cleaned = cleaned.replace(/CAUTION:.*?(?=\n\n|\n[A-Z])/gs, '');
  cleaned = cleaned.replace(/\*{3,}.*?EXTERNAL.*?\*{3,}/gi, '');
  cleaned = cleaned.replace(/\[EXTERNAL\].*?\n/gi, '');
  cleaned = cleaned.replace(/EXTERNAL EMAIL:.*?(?=\n\n)/gis, '');
  cleaned = cleaned.replace(/This email originated from outside.*?(?=\n\n)/gis, '');
  cleaned = cleaned.replace(/This message is from an external sender.*?(?=\n\n)/gis, '');

  // Remove CONFIDENTIALITY NOTICE (typically at the end)
  cleaned = cleaned.replace(/CONFIDENTIALITY NOTICE:.*$/is, '');
  cleaned = cleaned.replace(/This email and any files transmitted.*$/is, '');
  cleaned = cleaned.replace(/This message may contain confidential.*$/is, '');
  cleaned = cleaned.replace(/NOTICE: This e-mail.*$/is, '');
  cleaned = cleaned.replace(/DISCLAIMER:.*$/is, '');
  cleaned = cleaned.replace(/This communication is intended.*$/is, '');

  // Remove quoted text (> prefixed lines)
  cleaned = cleaned.replace(/^>.*$/gm, '');

  // Remove "On [date] [person] wrote:" style quote headers and everything after
  cleaned = cleaned.replace(/On .{1,100} wrote:[\s\S]*$/i, '');

  // Remove Outlook-style quote headers
  cleaned = cleaned.replace(/From:.*?Sent:.*?Subject:.*?[\s\S]*$/is, '');
  cleaned = cleaned.replace(/-----Original Message-----[\s\S]*$/i, '');

  // Remove Gmail-style forwarded headers
  cleaned = cleaned.replace(/---------- Forwarded message ---------[\s\S]*$/i, '');

  // Clean up excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Check if an email has significant boilerplate that would be cleaned
 */
export function hasSignificantBoilerplate(rawBody: string): boolean {
  if (!rawBody) return false;

  const cleaned = cleanEmailBody(rawBody);
  const originalLength = rawBody.length;
  const cleanedLength = cleaned.length;

  // If more than 20% was removed, consider it significant
  return (originalLength - cleanedLength) / originalLength > 0.2;
}
