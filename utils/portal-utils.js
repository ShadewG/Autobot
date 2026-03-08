/**
 * Maps email sender domains to portal providers for inbound email matching.
 * Key = domain (or subdomain.domain), Value = { provider, subdomainFromLocalPart }
 *   subdomainFromLocalPart: true means the subdomain is the local part of the sender
 *   (e.g. fortcollinspoliceco@request.justfoia.com → subdomain "fortcollinspoliceco")
 */
const PORTAL_EMAIL_DOMAINS = {
    'nextrequest.com':        { provider: 'nextrequest', subdomainFromLocalPart: false },
    'request.justfoia.com':   { provider: 'justfoia',    subdomainFromLocalPart: true },
    'mycusthelp.net':         { provider: 'govqa',       subdomainFromLocalPart: true },
    'mycusthelp.com':         { provider: 'govqa',       subdomainFromLocalPart: true },
    'custhelp.com':           { provider: 'govqa',       subdomainFromLocalPart: true },
    'govqa.us':               { provider: 'govqa',       subdomainFromLocalPart: true },
    'civicplus.com':          { provider: 'civicplus',   subdomainFromLocalPart: false }
};

const PORTAL_PROVIDERS = [
    {
        name: 'govqa',
        label: 'GovQA',
        domains: ['govqa.us', 'custhelp.com', 'mycusthelp.com'],
        keywords: ['govqa', 'public records center', 'my request center', 'request center notification'],
        defaultPath: '/WEBAPP/_rs/(S(0))/RequestLogin.aspx?rqst=4'
    },
    {
        name: 'nextrequest',
        label: 'NextRequest',
        domains: ['nextrequest.com'],
        keywords: ['nextrequest', 'public records request portal'],
        defaultPath: '/'
    },
    {
        name: 'justfoia',
        label: 'JustFOIA',
        domains: ['justfoia.com'],
        keywords: ['justfoia', 'govbuilt'],
        defaultPath: '/'
    },
    {
        name: 'civicplus',
        label: 'CivicPlus',
        domains: ['civicplus.com'],
        keywords: ['civicplus', 'civic plus', 'request tracker'],
        defaultPath: '/'
    }
];

const TRACKING_URL_PATTERNS = [
    /sendgrid\.net/i,
    /\.ct\.sendgrid\.net/i,
    /click\.mailchimp\.com/i,
    /track\.hubspot\.com/i,
    /links\.govdelivery\.com/i,
    /email\.mg\./i,
    /click\.\w+mail/i,
    /trk\.klclick/i,
];

function normalizePortalUrl(url) {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

    // Reject email tracking/redirect URLs
    if (TRACKING_URL_PATTERNS.some(pattern => pattern.test(trimmed))) {
        return null;
    }

    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }

    return `https://${trimmed}`;
}

function getHostname(url) {
    try {
        const normalized = normalizePortalUrl(url);
        if (!normalized) return null;
        return new URL(normalized).hostname.toLowerCase();
    } catch (error) {
        return null;
    }
}

function detectPortalProviderByHostname(hostname) {
    if (!hostname) return null;

    return PORTAL_PROVIDERS.find(provider =>
        provider.domains.some(domain => hostname.includes(domain))
    ) || null;
}

function detectPortalProviderByUrl(url) {
    const hostname = getHostname(url);
    if (!hostname) return null;
    return detectPortalProviderByHostname(hostname);
}

/**
 * Detect if an inbound email is a portal system message that should NOT go
 * through the AI classifier pipeline. Returns { type, provider } or null.
 *
 * Covers: password resets, welcome/onboarding, email confirmations,
 * account unlock, duplicate closure notices, and portal-closed notices.
 */
function detectPortalSystemEmail(fromEmail, subject) {
    if (!fromEmail || !subject) return null;
    const domain = (fromEmail.split('@')[1] || '').toLowerCase();
    const subjectLower = subject.toLowerCase();

    // Check if sender is a known portal domain
    let provider = null;
    for (const [emailDomain, config] of Object.entries(PORTAL_EMAIL_DOMAINS)) {
        if (domain === emailDomain || domain.endsWith('.' + emailDomain)) {
            provider = config.provider;
            break;
        }
    }
    if (!provider) return null;

    // Match subject patterns for system emails
    const systemPatterns = [
        { pattern: /password\s*reset|reset\s*(your\s*)?password/i, type: 'password_reset' },
        { pattern: /welcome\s*to\s*(the|your)?/i, type: 'welcome' },
        { pattern: /confirm\s*(your\s*)?email|email\s*confirm/i, type: 'email_confirmation' },
        { pattern: /unlock\s*(your\s*)?account|account\s*unlock/i, type: 'account_unlock' },
        { pattern: /verify\s*(your\s*)?email|email\s*verif/i, type: 'email_verification' },
        { pattern: /account\s*(has\s*been\s*)?created/i, type: 'account_created' },
        { pattern: /activate\s*(your\s*)?account/i, type: 'account_activation' },
    ];

    for (const { pattern, type } of systemPatterns) {
        if (pattern.test(subjectLower)) {
            return { type, provider };
        }
    }

    return null;
}

function isSupportedPortalUrl(url) {
    if (!url) return false;

    const normalized = normalizePortalUrl(url);
    if (!normalized) return false;

    try {
        const urlObj = new URL(normalized);
        const pathname = urlObj.pathname.toLowerCase();

        // Reject document file URLs — these are downloads, not portals
        if (/\.(pdf|doc|docx|xls|xlsx|rtf|odt)$/i.test(pathname)) {
            return false;
        }

        // Accept all other URLs (let Skyvern attempt them)
        return true;
    } catch (error) {
        return false;
    }
}

module.exports = {
    PORTAL_PROVIDERS,
    PORTAL_EMAIL_DOMAINS,
    normalizePortalUrl,
    detectPortalProviderByUrl,
    detectPortalProviderByHostname,
    detectPortalSystemEmail,
    isSupportedPortalUrl
};
