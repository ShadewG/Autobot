/**
 * Shared text sanitization utilities for draft and execution steps.
 */

/** Returns true if the text claims an attachment is included. */
export function textClaimsAttachment(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(attached|attachment|enclosed|enclosure)\b/i.test(text)
    || /\b(include|included|including)\b[\s\S]{0,40}\b(with this email|in this email|as an attachment|as attached|enclosed)\b/i.test(text);
}

/** Removes lines that explicitly claim this outbound message includes files. */
export function stripAttachmentClaimLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const cleaned = lines.filter((line) => {
    return !/\b(attached|attachment|enclosed|enclosure)\b/i.test(line)
      && !/\b(include|included|including)\b[\s\S]{0,40}\b(with this email|in this email|as an attachment|as attached|enclosed)\b/i.test(line);
  });
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
