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

const PORTAL_ENTRY_MARKERS = [
    '/portal',
    '/request',
    '/requests',
    '/publicrecords',
    '/public-records',
    '/recordrequest',
    '/record-request',
    '/foia',
    '/formcenter',
    '/forms',
    '/openrecords',
    '/open-records',
];

const CONTACT_MARKERS = ['/contact', '/contacts', '/staff', '/directory', '/about', '/pio'];
const DOCUMENTATION_MARKERS = ['/docs', '/documentation', '/help', '/support', '/faq', '/kb', '/knowledge'];
const DOWNLOAD_EXTENSION_PATTERN = /\.(pdf|doc|docx|xls|xlsx|rtf|odt|zip|jpg|jpeg|png)$/i;
const KNOWN_AUTOMATABLE_PROVIDERS = new Set(['govqa', 'nextrequest', 'justfoia', 'civicplus']);

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

function isNonAutomatablePortalProvider(provider) {
    if (!provider) return false;
    const value = String(provider).toLowerCase();
    return (
        value.includes('no online portal') ||
        value.includes('paper form required') ||
        value.includes('paper form') ||
        value.includes('mail-in form') ||
        value.includes('custom form')
    );
}

function isNonAutomatablePortalStatus(status) {
    if (!status) return false;
    const value = String(status).toLowerCase();
    return (
        value.includes('alternative path required') ||
        value.includes('pdf_form_pending') ||
        value.includes('not_real_portal') ||
        value.includes('contact_info_only') ||
        value.includes('manual_research_required')
    );
}

function isLikelyContactInfoUrl(url) {
    if (!url) return false;
    const value = String(url).toLowerCase();
    let firstPathSegment = '';
    try {
        const pathname = new URL(normalizePortalUrl(url)).pathname || '/';
        firstPathSegment = pathname.toLowerCase().split('/').filter(Boolean)[0] || '';
    } catch (error) {}
    const hasContactMarker = CONTACT_MARKERS.some((needle) => value.includes(needle));
    const hasPortalMarker = PORTAL_ENTRY_MARKERS.some((needle) => value.includes(needle))
        || value.includes('nextrequest');
    const startsWithContactRoot = ['contact', 'contacts', 'staff', 'directory', 'about', 'pio'].includes(firstPathSegment);
    return startsWithContactRoot || (hasContactMarker && !hasPortalMarker);
}

function isLikelyDocumentationPortalUrl(url) {
    if (!url) return false;
    const value = String(url).toLowerCase();
    return DOCUMENTATION_MARKERS.some((needle) => value.includes(needle));
}

function getPortalPathClass(url, provider = null) {
    const normalized = normalizePortalUrl(url);
    if (!normalized) return 'invalid';

    try {
        const urlObj = new URL(normalized);
        const pathname = (urlObj.pathname || '/').toLowerCase();
        const hostname = urlObj.hostname.toLowerCase();
        const providerName = String(provider || detectPortalProviderByUrl(normalized)?.name || '').toLowerCase();

        if (TRACKING_URL_PATTERNS.some((pattern) => pattern.test(normalized))) return 'tracking';
        if (DOWNLOAD_EXTENSION_PATTERN.test(pathname)) return 'download';
        if (isLikelyDocumentationPortalUrl(normalized)) return 'documentation';
        if (isLikelyContactInfoUrl(normalized)) return 'contact';
        if (pathname.includes('/login') || pathname.includes('/signin') || pathname.includes('/requestlogin.aspx')) {
            return 'portal_entry';
        }
        if (PORTAL_ENTRY_MARKERS.some((needle) => pathname.includes(needle))) return 'portal_entry';
        if (KNOWN_AUTOMATABLE_PROVIDERS.has(providerName)) return 'portal_entry';
        if (hostname.includes('nextrequest.com') || hostname.includes('govqa.us') || hostname.includes('justfoia.com')) {
            return 'portal_entry';
        }
        if (pathname === '/' || pathname === '') return 'unknown_root';
        return 'unknown_candidate';
    } catch (error) {
        return 'invalid';
    }
}

function buildPortalPathHint(url) {
    const normalized = normalizePortalUrl(url);
    if (!normalized) return 'invalid';

    try {
        const { pathname } = new URL(normalized);
        const segments = String(pathname || '/')
            .toLowerCase()
            .split('/')
            .filter(Boolean)
            .slice(0, 2);
        return segments.length > 0 ? `/${segments.join('/')}` : '/';
    } catch (error) {
        return 'invalid';
    }
}

function buildPortalFingerprint(url, provider = null) {
    const normalized = normalizePortalUrl(url);
    if (!normalized) return null;

    try {
        const normalizedUrl = new URL(normalized);
        const detectedProvider = provider || detectPortalProviderByUrl(normalized)?.name || 'unknown';
        const pathClass = getPortalPathClass(normalized, detectedProvider);
        const pathHint = buildPortalPathHint(normalized);
        return {
            normalizedUrl: normalizedUrl.toString(),
            host: normalizedUrl.hostname.toLowerCase(),
            provider: String(detectedProvider || 'unknown').toLowerCase(),
            pathClass,
            pathHint,
            fingerprint: `${String(detectedProvider || 'unknown').toLowerCase()}|${normalizedUrl.hostname.toLowerCase()}|${pathClass}|${pathHint}`,
        };
    } catch (error) {
        return null;
    }
}

function evaluatePortalAutomationDecision({
    portalUrl,
    provider = null,
    lastPortalStatus = null,
    policyStatus = null,
    policyReason = null,
} = {}) {
    const fingerprint = buildPortalFingerprint(portalUrl, provider);
    if (!fingerprint) {
        return {
            decision: 'block',
            status: 'invalid',
            reason: 'missing_portal_url',
            portalFingerprint: null,
            normalizedUrl: null,
            provider: provider || null,
            pathClass: 'invalid',
        };
    }

    const normalizedProvider = String(provider || fingerprint.provider || '').toLowerCase();
    const normalizedPolicyStatus = String(policyStatus || '').toLowerCase() || null;

    if (isNonAutomatablePortalProvider(provider)) {
        return {
            decision: 'block',
            status: 'blocked',
            reason: 'non_automatable_provider',
            portalFingerprint: fingerprint.fingerprint,
            normalizedUrl: fingerprint.normalizedUrl,
            provider: normalizedProvider || null,
            pathClass: fingerprint.pathClass,
        };
    }

    if (isNonAutomatablePortalStatus(lastPortalStatus)) {
        return {
            decision: 'block',
            status: 'blocked',
            reason: 'non_automatable_status',
            portalFingerprint: fingerprint.fingerprint,
            normalizedUrl: fingerprint.normalizedUrl,
            provider: normalizedProvider || null,
            pathClass: fingerprint.pathClass,
        };
    }

    if (['tracking', 'download', 'documentation', 'contact', 'invalid'].includes(fingerprint.pathClass)) {
        return {
            decision: 'block',
            status: 'blocked',
            reason: fingerprint.pathClass,
            portalFingerprint: fingerprint.fingerprint,
            normalizedUrl: fingerprint.normalizedUrl,
            provider: normalizedProvider || null,
            pathClass: fingerprint.pathClass,
        };
    }

    if (normalizedPolicyStatus === 'blocked') {
        return {
            decision: 'block',
            status: 'blocked',
            reason: policyReason || 'manual_only_policy',
            portalFingerprint: fingerprint.fingerprint,
            normalizedUrl: fingerprint.normalizedUrl,
            provider: normalizedProvider || null,
            pathClass: fingerprint.pathClass,
        };
    }

    if (normalizedPolicyStatus === 'trusted') {
        return {
            decision: 'allow',
            status: 'trusted',
            reason: policyReason || 'trusted_policy',
            portalFingerprint: fingerprint.fingerprint,
            normalizedUrl: fingerprint.normalizedUrl,
            provider: normalizedProvider || null,
            pathClass: fingerprint.pathClass,
        };
    }

    if (KNOWN_AUTOMATABLE_PROVIDERS.has(normalizedProvider) && fingerprint.pathClass === 'portal_entry') {
        return {
            decision: 'allow',
            status: 'auto_supported',
            reason: 'known_provider_portal',
            portalFingerprint: fingerprint.fingerprint,
            normalizedUrl: fingerprint.normalizedUrl,
            provider: normalizedProvider || null,
            pathClass: fingerprint.pathClass,
        };
    }

    return {
        decision: 'review',
        status: 'needs_confirmation',
        reason: 'operator_confirmation_required',
        portalFingerprint: fingerprint.fingerprint,
        normalizedUrl: fingerprint.normalizedUrl,
        provider: normalizedProvider || null,
        pathClass: fingerprint.pathClass,
    };
}

function isSupportedPortalUrl(url, provider = null, lastPortalStatus = null) {
    if (!url) return false;

    const normalized = normalizePortalUrl(url);
    if (!normalized) return false;
    if (isNonAutomatablePortalProvider(provider)) return false;
    if (isNonAutomatablePortalStatus(lastPortalStatus)) return false;
    if (isLikelyContactInfoUrl(normalized)) return false;
    if (isLikelyDocumentationPortalUrl(normalized)) return false;

    try {
        const urlObj = new URL(normalized);
        const pathname = urlObj.pathname.toLowerCase();

        // Reject document file URLs — these are downloads, not portals
        if (DOWNLOAD_EXTENSION_PATTERN.test(pathname)) {
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
    isSupportedPortalUrl,
    isNonAutomatablePortalProvider,
    isNonAutomatablePortalStatus,
    getPortalPathClass,
    buildPortalFingerprint,
    evaluatePortalAutomationDecision,
};
