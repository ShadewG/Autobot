const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_REGEX = /(https?:\/\/[^\s"'<>]+)/gi;

function normalizeValue(value) {
    if (!value) return '';
    if (Array.isArray(value)) {
        return value.filter(Boolean).join(' ');
    }
    return String(value);
}

function extractEmails(value) {
    const text = normalizeValue(value);
    if (!text) return [];
    const matches = text.match(EMAIL_REGEX) || [];
    const deduped = new Set(matches.map(email => email.trim()));
    return Array.from(deduped);
}

function extractUrls(value) {
    const text = normalizeValue(value);
    if (!text) return [];
    const matches = text.match(URL_REGEX) || [];
    const deduped = new Set(matches.map(url => url.trim()));
    return Array.from(deduped);
}

function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const trimmed = email.trim();
    if (trimmed.includes(' ')) return false;
    return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(trimmed);
}

module.exports = {
    extractEmails,
    extractUrls,
    isValidEmail
};
