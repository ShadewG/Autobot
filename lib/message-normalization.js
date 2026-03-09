const { cleanEmailBody, htmlToPlainText } = require('./email-cleaner');

const PORTAL_ADMIN_ONLY_REGEX = /temporary password|password assistance|unlock (?:your )?(?:public )?portal account|unlock your account|account unlock|account locked|reset (?:your )?password|welcome to .*records center|verify your email|email confirmation|account activation|portal account|login id|create a permanent password|track and monitor the status of your request|records center account|access your account online|sign in to your account/i;
const SUBSTANTIVE_OVERRIDE_REGEX = /denied|denial|withheld|withhold|exempt|fee|cost|invoice|payment|clarif|please provide|mailing address|request form|records ready|attached records|responsive records|download|wrong agency|not the correct agency|no records|ongoing investigation|release|redact|public records request|open records request/i;

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanPreservingFallback(rawText) {
  const normalized = normalizeWhitespace(rawText);
  if (!normalized) return '';
  const cleaned = normalizeWhitespace(cleanEmailBody(normalized));
  return cleaned || normalized;
}

function normalizeMessageBody({ body_text = '', body_html = '' } = {}) {
  const plainText = cleanPreservingFallback(body_text);
  if (plainText) {
    return {
      normalized_body_text: plainText,
      normalized_body_source: 'body_text',
    };
  }

  const htmlText = cleanPreservingFallback(htmlToPlainText(body_html));
  if (htmlText) {
    return {
      normalized_body_text: htmlText,
      normalized_body_source: 'body_html',
    };
  }

  return {
    normalized_body_text: '',
    normalized_body_source: null,
  };
}

function getCanonicalMessageText(message = {}) {
  const stored = normalizeWhitespace(message.normalized_body_text);
  if (stored) return stored;
  return normalizeMessageBody(message).normalized_body_text;
}

function isSubstantiveMessage(message = {}) {
  const direction = String(message.direction || '').toLowerCase();
  const messageType = String(message.message_type || '').toLowerCase();
  const subject = normalizeWhitespace(message.subject);
  const text = getCanonicalMessageText(message);
  const combined = `${subject}\n${text}`.trim().toLowerCase();

  if (!combined) return false;

  if (direction !== 'inbound') {
    return true;
  }

  if (messageType === 'portal_system') {
    return false;
  }

  if (
    message.portal_notification &&
    PORTAL_ADMIN_ONLY_REGEX.test(combined) &&
    !SUBSTANTIVE_OVERRIDE_REGEX.test(combined)
  ) {
    return false;
  }

  return true;
}

function buildMessagePreviewText(message = {}, maxLength = 1200) {
  const text = getCanonicalMessageText(message);
  const fallback = text || `[No text body] ${String(message.subject || '(no subject)').trim()}`;
  return normalizeWhitespace(fallback).slice(0, maxLength);
}

module.exports = {
  normalizeMessageBody,
  getCanonicalMessageText,
  isSubstantiveMessage,
  buildMessagePreviewText,
};
