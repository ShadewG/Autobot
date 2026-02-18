/**
 * Email body cleaner utility
 * Removes common email boilerplate like:
 * - CAUTION/WARNING blocks
 * - CONFIDENTIALITY NOTICE footers
 * - Quoted reply chains
 * - External email warnings
 */

function cleanEmailBody(rawBody) {
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
 * Convert HTML to readable plain text.
 * Handles <br>, <p>, <div>, block elements, HTML entities, and strips remaining tags.
 */
function htmlToPlainText(html) {
  if (!html) return '';

  let text = html;

  // Remove <style>, <script>, and <head> blocks entirely
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

  // Remove tracking pixels (1x1 images)
  text = text.replace(/<img[^>]*(?:width="1"|height="1")[^>]*\/?>/gi, '');

  // <br> → newline
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // <hr> → separator
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Block-level closing tags → newline
  text = text.replace(/<\/(?:p|div|tr|li|h[1-6]|blockquote)>/gi, '\n');

  // <li> → bullet
  text = text.replace(/<li[^>]*>/gi, '• ');

  // Decode common HTML entities
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&rsquo;/gi, '\u2019');
  text = text.replace(/&lsquo;/gi, '\u2018');
  text = text.replace(/&rdquo;/gi, '\u201D');
  text = text.replace(/&ldquo;/gi, '\u201C');
  text = text.replace(/&mdash;/gi, '\u2014');
  text = text.replace(/&ndash;/gi, '\u2013');
  text = text.replace(/&emsp;/gi, '  ');
  text = text.replace(/&ensp;/gi, ' ');
  text = text.replace(/&#\d+;/g, ''); // Remove remaining numeric entities

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ');        // Collapse horizontal whitespace
  text = text.replace(/\n /g, '\n');           // Remove leading space after newline
  text = text.replace(/ \n/g, '\n');           // Remove trailing space before newline
  text = text.replace(/\n{3,}/g, '\n\n');      // Collapse excessive newlines
  text = text.trim();

  return text;
}

module.exports = { cleanEmailBody, htmlToPlainText };
