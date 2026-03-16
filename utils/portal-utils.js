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
    },
    {
        name: 'formcenter',
        label: 'FormCenter',
        domains: [],
        keywords: ['formcenter'],
        defaultPath: '/'
    },
    {
        name: 'smartsheet',
        label: 'Smartsheet',
        domains: ['smartsheet.com'],
        keywords: ['smartsheet'],
        defaultPath: '/'
    },
    {
        name: 'coplogic',
        label: 'Coplogic',
        domains: ['coplogic.com'],
        keywords: ['coplogic'],
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
const MANUAL_REQUEST_MARKERS = ['/records-reports', '/recordsreports', '/records-report'];
const DOCUMENTATION_MARKERS = ['/docs', '/documentation', '/help', '/support', '/faq', '/kb', '/knowledge'];
const DOWNLOAD_EXTENSION_PATTERN = /\.(pdf|doc|docx|xls|xlsx|rtf|odt|zip|jpg|jpeg|png)$/i;
const KNOWN_AUTOMATABLE_PROVIDERS = new Set(['govqa', 'nextrequest', 'justfoia', 'civicplus', 'formcenter']);
const KNOWN_PROVIDER_NAMES = new Set(PORTAL_PROVIDERS.map((provider) => provider.name));
const NON_PORTAL_HOSTS = new Set([
    'civicplus.help',
    'uploads.govqa.us',
]);
const PLACEHOLDER_PROVIDER_HINTS = new Set([
    '',
    'auto-detected',
    'auto detected',
    'none',
    'unknown',
    'n/a',
    'na',
    'null',
]);
const ASSET_PATH_MARKERS = ['/download/', '/downloads/', '/upload/', '/uploads/', '/files/', '/images/', '/image/'];
const REQUEST_FORM_DOCUMENT_PATH_MARKERS = [
    '/documentcenter/view/',
    '/forms/',
    '/form/',
    '/openrec.',
    '/open-record',
    '/records-request',
    '/public-records-request',
];

function isGenericJustFoiaRoot(hostname, pathname, providerName = '') {
    const normalizedHost = String(hostname || '').toLowerCase();
    const normalizedPath = String(pathname || '/').toLowerCase();
    const normalizedProvider = String(providerName || '').toLowerCase();
    return (
        normalizedProvider === 'justfoia' &&
        normalizedHost === 'request.justfoia.com' &&
        (normalizedPath === '/' || normalizedPath === '')
    );
}

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
    const normalized = normalizePortalUrl(url);
    const hostname = getHostname(normalized);
    if (!hostname) return null;

    const detectedByHost = detectPortalProviderByHostname(hostname);
    if (detectedByHost?.name === 'civicplus' && String(normalized || '').toLowerCase().includes('/formcenter/')) {
        return PORTAL_PROVIDERS.find(provider => provider.name === 'formcenter') || detectedByHost;
    }
    if (detectedByHost) return detectedByHost;

    try {
        const pathname = new URL(normalized).pathname.toLowerCase();
        if (pathname.includes('/formcenter/')) {
            return PORTAL_PROVIDERS.find(provider => provider.name === 'formcenter') || null;
        }
        if (hostname === 'app.smartsheet.com' && pathname.includes('/b/form/')) {
            return PORTAL_PROVIDERS.find(provider => provider.name === 'smartsheet') || null;
        }
        if (hostname.includes('coplogic.com')) {
            return PORTAL_PROVIDERS.find(provider => provider.name === 'coplogic') || null;
        }
    } catch (error) {}

    return null;
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
        value.includes('no online submission portal') ||
        value.includes('paper form required') ||
        value.includes('paper form') ||
        value.includes('mail-in form') ||
        value.includes('custom form') ||
        value.includes('manual page') ||
        value.includes('pdf form download') ||
        value.includes('download only')
    );
}

function normalizePortalProviderHint(provider, url = null) {
    const rawValue = String(provider || '').trim();
    const normalizedValue = rawValue.toLowerCase();
    const detectedProvider = detectPortalProviderByUrl(url)?.name || null;

    if (!normalizedValue || PLACEHOLDER_PROVIDER_HINTS.has(normalizedValue)) {
        return detectedProvider;
    }

    if (isNonAutomatablePortalProvider(normalizedValue)) {
        return normalizedValue;
    }

    if (detectedProvider) {
        if (!KNOWN_PROVIDER_NAMES.has(normalizedValue)) {
            return detectedProvider;
        }
        if (normalizedValue === 'civicplus' && detectedProvider === 'formcenter') {
            return detectedProvider;
        }
    }

    return normalizedValue;
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
    const hasManualRequestMarker = MANUAL_REQUEST_MARKERS.some((needle) => value.includes(needle));
    const hasPortalMarker = PORTAL_ENTRY_MARKERS.some((needle) => value.includes(needle))
        || value.includes('nextrequest');
    const startsWithContactRoot = ['contact', 'contacts', 'staff', 'directory', 'about', 'pio'].includes(firstPathSegment);
    return startsWithContactRoot || hasManualRequestMarker || (hasContactMarker && !hasPortalMarker);
}

function isLikelyDocumentationPortalUrl(url) {
    if (!url) return false;
    const value = String(url).toLowerCase();
    const providerName = detectPortalProviderByUrl(value)?.name || '';
    if (providerName === 'govqa' && value.includes('supporthome.aspx')) {
        return false;
    }
    if (providerName === 'formcenter' && value.includes('/formcenter/')) {
        return false;
    }
    return DOCUMENTATION_MARKERS.some((needle) => value.includes(needle));
}

function isLikelyAssetPortalUrl(url) {
    if (!url) return false;
    const value = String(url).toLowerCase();
    return ASSET_PATH_MARKERS.some((needle) => value.includes(needle));
}

function classifyProviderPath(urlObj, providerName = '') {
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = (urlObj.pathname || '/').toLowerCase();

    if (NON_PORTAL_HOSTS.has(hostname)) return 'documentation';
    if (TRACKING_URL_PATTERNS.some((pattern) => pattern.test(urlObj.toString()))) return 'tracking';
    if (DOWNLOAD_EXTENSION_PATTERN.test(pathname) || isLikelyAssetPortalUrl(urlObj.toString())) return 'download';
    if (isLikelyDocumentationPortalUrl(urlObj.toString())) return 'documentation';
    if (isLikelyContactInfoUrl(urlObj.toString())) return 'contact';

    switch (providerName) {
        case 'govqa':
            if (hostname === 'uploads.govqa.us') return 'download';
            if (pathname.includes('/webapp/') || pathname.includes('requestlogin.aspx') || pathname.includes('supporthome.aspx') || pathname.includes('customerhome.aspx') || pathname.includes('requestselect.aspx')) {
                return 'portal_entry';
            }
            return pathname === '/' || pathname === '' ? 'unknown_root' : 'unknown_candidate';
        case 'nextrequest':
            if (hostname === 'nextrequest.com' || hostname === 'www.nextrequest.com') return 'unknown_root';
            if (hostname.endsWith('.nextrequest.com')) {
                if (pathname === '/' || pathname === '' || pathname === '/requests' || pathname.startsWith('/requests/')) {
                    return 'portal_entry';
                }
                return 'unknown_candidate';
            }
            return pathname === '/' || pathname === '' ? 'unknown_root' : 'unknown_candidate';
        case 'justfoia':
            if (isGenericJustFoiaRoot(hostname, pathname, providerName)) return 'unknown_root';
            if (pathname.includes('/publicportal') || pathname.includes('/forms/launch') || pathname.startsWith('/forms/')) {
                return 'portal_entry';
            }
            return pathname === '/' || pathname === '' ? 'unknown_root' : 'unknown_candidate';
        case 'formcenter':
            if (pathname.includes('/formcenter/')) return 'portal_entry';
            return pathname === '/' || pathname === '' ? 'unknown_root' : 'documentation';
        case 'smartsheet':
            if (hostname === 'app.smartsheet.com' && pathname.includes('/b/form/')) return 'portal_entry';
            return pathname === '/' || pathname === '' ? 'unknown_root' : 'unknown_candidate';
        case 'coplogic':
            if (pathname.includes('/dors/') || pathname.includes('/publicreport')) return 'portal_entry';
            return pathname === '/' || pathname === '' ? 'unknown_root' : 'unknown_candidate';
        default:
            if (pathname === '/' || pathname === '') return 'unknown_root';
            return 'unknown_candidate';
    }
}

function getPortalPathClass(url, provider = null) {
    const normalized = normalizePortalUrl(url);
    if (!normalized) return 'invalid';

    try {
        const urlObj = new URL(normalized);
        const providerName = String(provider || detectPortalProviderByUrl(normalized)?.name || '').toLowerCase();
        const classified = classifyProviderPath(urlObj, providerName);
        if (classified) return classified;
        const pathname = (urlObj.pathname || '/').toLowerCase();
        if (pathname.includes('/login') || pathname.includes('/signin') || pathname.includes('/requestlogin.aspx')) {
            return 'portal_entry';
        }
        if (PORTAL_ENTRY_MARKERS.some((needle) => pathname.includes(needle))) return 'portal_entry';
        return pathname === '/' || pathname === '' ? 'unknown_root' : 'unknown_candidate';
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
        const detectedProvider = normalizePortalProviderHint(provider, normalized) || 'unknown';
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

function isRequestFormDocumentUrl(url) {
    const normalized = normalizePortalUrl(url);
    if (!normalized) return false;

    try {
        const urlObj = new URL(normalized);
        const pathname = (urlObj.pathname || '/').toLowerCase();
        if (/\.(pdf|doc|docx|xls|xlsx|rtf|odt)$/i.test(pathname)) {
            return true;
        }
        return REQUEST_FORM_DOCUMENT_PATH_MARKERS.some((needle) => pathname.includes(needle));
    } catch (error) {
        return false;
    }
}

function classifyRequestChannelUrl(url, provider = null, lastPortalStatus = null) {
    const normalized = normalizePortalUrl(url);
    if (!normalized) {
        return {
            kind: 'discard',
            normalizedUrl: null,
            provider: provider || null,
            pathClass: 'invalid',
            reason: 'missing_or_invalid_url',
        };
    }

    try {
        const detectedProvider = normalizePortalProviderHint(provider, normalized);
        const pathClass = getPortalPathClass(normalized, detectedProvider);
        const pathname = new URL(normalized).pathname.toLowerCase();

        if (TRACKING_URL_PATTERNS.some((pattern) => pattern.test(normalized))) {
            return {
                kind: 'discard',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass: 'tracking',
                reason: 'tracking_url',
            };
        }

        if (isGenericJustFoiaRoot(getHostname(normalized), pathname, detectedProvider)) {
            return {
                kind: 'discard',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: 'generic_justfoia_root',
            };
        }

        if (isNonAutomatablePortalProvider(provider)) {
            return {
                kind: isRequestFormDocumentUrl(normalized) ? 'pdf_form' : 'manual_request',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: 'non_automatable_provider',
            };
        }

        if (isNonAutomatablePortalStatus(lastPortalStatus)) {
            return {
                kind: isRequestFormDocumentUrl(normalized) ? 'pdf_form' : 'manual_request',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: 'non_automatable_status',
            };
        }

        if (isRequestFormDocumentUrl(normalized)) {
            return {
                kind: 'pdf_form',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: 'request_form_document',
            };
        }

        if (isLikelyContactInfoUrl(normalized) || isLikelyDocumentationPortalUrl(normalized)) {
            return {
                kind: 'manual_request',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: isLikelyContactInfoUrl(normalized) ? 'manual_request_page' : 'documentation',
            };
        }

        if (isSupportedPortalUrl(normalized, detectedProvider, lastPortalStatus)) {
            return {
                kind: 'portal',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: 'real_portal_candidate',
            };
        }

        if (pathClass === 'download') {
            return {
                kind: isRequestFormDocumentUrl(normalized) ? 'pdf_form' : 'discard',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: isRequestFormDocumentUrl(normalized) ? 'downloadable_request_form' : 'non_portal_download',
            };
        }

        if (['contact', 'documentation'].includes(pathClass)) {
            return {
                kind: 'manual_request',
                normalizedUrl: normalized,
                provider: detectedProvider,
                pathClass,
                reason: pathClass,
            };
        }

        return {
            kind: 'discard',
            normalizedUrl: normalized,
            provider: detectedProvider,
            pathClass,
            reason: 'non_portal_candidate',
        };
    } catch (error) {
        return {
            kind: 'discard',
            normalizedUrl: null,
            provider: provider || null,
            pathClass: 'invalid',
            reason: 'invalid_url',
        };
    }
}

function normalizeRequestChannelFields(fields = {}) {
    const result = {
        portal_url: null,
        portal_provider: null,
        manual_request_url: null,
        pdf_form_url: null,
    };

    const candidates = [
        { url: fields.portal_url, provider: fields.portal_provider || null, source: 'portal_url' },
        { url: fields.manual_request_url, provider: null, source: 'manual_request_url' },
        { url: fields.pdf_form_url, provider: null, source: 'pdf_form_url' },
    ];

    for (const candidate of candidates) {
        if (!candidate.url) continue;
        const classified = classifyRequestChannelUrl(candidate.url, candidate.provider, fields.last_portal_status || null);
        if (classified.kind === 'portal' && !result.portal_url) {
            result.portal_url = classified.normalizedUrl;
            result.portal_provider = normalizePortalProviderHint(
                classified.provider,
                classified.normalizedUrl
            ) || null;
            continue;
        }
        if (classified.kind === 'manual_request' && !result.manual_request_url) {
            result.manual_request_url = classified.normalizedUrl;
            continue;
        }
        if (classified.kind === 'pdf_form' && !result.pdf_form_url) {
            result.pdf_form_url = classified.normalizedUrl;
        }
    }

    return result;
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

    const normalizedProvider = normalizePortalProviderHint(provider, fingerprint.normalizedUrl)
        || String(fingerprint.provider || '').toLowerCase()
        || null;
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

function derivePortalPolicyFromBrowserValidation({
    portalUrl,
    provider = null,
    validation = {},
} = {}) {
    const normalizedPortalUrl = normalizePortalUrl(portalUrl);
    const normalizedProvider = normalizePortalProviderHint(provider, normalizedPortalUrl) || 'unknown';
    const validationUrl = normalizePortalUrl(validation.final_url || validation.portalUrl || normalizedPortalUrl);
    const finalProvider = normalizePortalProviderHint(validation.provider || normalizedProvider, validationUrl || normalizedPortalUrl)
        || normalizedProvider;
    const pathClass = getPortalPathClass(validationUrl || normalizedPortalUrl, finalProvider);
    const pageKind = String(
        validation.pageKind
        || validation.page_kind
        || validation?.extracted_data?.page_kind
        || validation?.scout?.pageKind
        || ''
    ).toLowerCase() || null;
    const status = String(validation.status || '').toLowerCase() || null;

    if (['tracking', 'download', 'documentation', 'contact', 'invalid'].includes(pathClass)) {
        return {
            policyStatus: 'blocked',
            decisionReason: pathClass,
            pathClass,
            validationStatus: status,
            validationPageKind: pageKind,
            validationUrl: validationUrl || normalizedPortalUrl,
        };
    }

    if ([
        'unsupported_portal',
        'blocked_cloudflare',
        'blocked_access_restricted',
    ].includes(status)) {
        return {
            policyStatus: 'blocked',
            decisionReason: status,
            pathClass,
            validationStatus: status,
            validationPageKind: pageKind,
            validationUrl: validationUrl || normalizedPortalUrl,
        };
    }

    if (
        ['portal_entry', 'unknown_candidate', 'unknown_root'].includes(pathClass)
        && [
            'dry_run_form_filled',
            'dry_run_form_detected',
            'dry_run_auth_ready',
            'landing_page_detected',
            'auth_ready',
            'auth_not_required',
            'request_form_public',
        ].includes(status)
    ) {
        return {
            policyStatus: 'trusted',
            decisionReason: status || 'browser_validation_confirmed',
            pathClass,
            validationStatus: status,
            validationPageKind: pageKind,
            validationUrl: validationUrl || normalizedPortalUrl,
        };
    }

    if (pageKind === 'request_form' && ['portal_entry', 'unknown_candidate', 'unknown_root'].includes(pathClass)) {
        return {
            policyStatus: 'trusted',
            decisionReason: 'browser_validation_request_form',
            pathClass,
            validationStatus: status,
            validationPageKind: pageKind,
            validationUrl: validationUrl || normalizedPortalUrl,
        };
    }

    return {
        policyStatus: null,
        decisionReason: status || 'browser_validation_inconclusive',
        pathClass,
        validationStatus: status,
        validationPageKind: pageKind,
        validationUrl: validationUrl || normalizedPortalUrl,
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
        const providerName = normalizePortalProviderHint(provider, normalized);
        const pathClass = getPortalPathClass(normalized, providerName);

        if (isGenericJustFoiaRoot(urlObj.hostname, (urlObj.pathname || '/').toLowerCase(), providerName)) {
            return false;
        }

        if (['tracking', 'download', 'documentation', 'contact', 'invalid'].includes(pathClass)) {
            return false;
        }

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
    derivePortalPolicyFromBrowserValidation,
    classifyRequestChannelUrl,
    normalizeRequestChannelFields,
};
// Build cache buster: 1773666586
