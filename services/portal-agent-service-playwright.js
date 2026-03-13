const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const database = require('./database');
const EmailVerificationHelper = require('../agentkit/email-helper');
const { persistPortalScreenshot } = require('./portal-screenshot-store');
const portalScout = require('./portal-scout-service-lightpanda');
const {
    normalizePortalUrl,
    detectPortalProviderByUrl,
    isSupportedPortalUrl,
} = require('../utils/portal-utils');

const DEFAULT_ARTIFACTS_ROOT = path.join(process.cwd(), 'portal-run-results', 'playwright');
const DEFAULT_NAVIGATION_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_PORTAL_TIMEOUT_MS || '30000', 10);
const DEFAULT_SLOW_MO_MS = parseInt(process.env.PLAYWRIGHT_PORTAL_SLOW_MO_MS || '0', 10);
const DEFAULT_HEADLESS = process.env.PLAYWRIGHT_PORTAL_HEADLESS !== 'false';
const DEFAULT_TRACK_IN_AUTOBOT = process.env.PLAYWRIGHT_PORTAL_TRACK_IN_AUTOBOT === 'true';
const DEFAULT_SCOUT_ENABLED = String(process.env.LIGHTPANDA_PORTAL_SCOUT_ENABLED || 'true').toLowerCase() !== 'false';
const DEFAULT_BROWSERBASE_REGION = process.env.BROWSERBASE_REGION || 'us-east-1';
const BROWSERBASE_SESSION_URL_PREFIX = 'https://www.browserbase.com/sessions/';
const DEFAULT_PORTAL_VERIFICATION_CODE_PATTERN = '(\\d{4,8})';
const SUBMIT_CONTROL_SELECTOR = [
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    'a[role="button"]',
    'a.modern-button',
    'a.button',
    'a[href="#"]',
].join(', ');
const NEXTREQUEST_MAGIC_LINK_PATTERN = "(https?:\\/\\/[^\\s\"']+\\/users\\/(?:confirmation|unlock|password\\/edit)[^\\s\"']*)";

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function normalizeBrowserBackend(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === 'auto') return 'auto';
    if (['browserbase', 'hosted', 'remote'].includes(normalized)) return 'browserbase';
    return 'local';
}

function resolveBrowserBackendSelection(value, hasBrowserbaseApiKey = Boolean(process.env.BROWSERBASE_API_KEY)) {
    const normalized = normalizeBrowserBackend(value);
    if (normalized === 'browserbase' || normalized === 'local') return normalized;
    return hasBrowserbaseApiKey ? 'browserbase' : 'local';
}

function coerceBrowserbaseOs(value, advancedStealth = false) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['windows', 'mac', 'linux', 'mobile', 'tablet'].includes(normalized)) {
        return normalized;
    }
    return advancedStealth ? 'windows' : 'linux';
}

function buildBrowserbaseSessionUrl(sessionId) {
    return sessionId ? `${BROWSERBASE_SESSION_URL_PREFIX}${sessionId}` : null;
}

function parseCsvSet(value) {
    return new Set(
        String(value || '')
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
    );
}

function hostMatchesSet(portalUrl, values) {
    if (!portalUrl || !values || values.size === 0) return false;
    let hostname = '';
    try {
        hostname = new URL(portalUrl).hostname.toLowerCase();
    } catch (_) {
        hostname = String(portalUrl || '').toLowerCase();
    }
    return Array.from(values).some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

const DEFAULT_BROWSERBASE_AUTH_CONTEXT_PROVIDERS = parseCsvSet(
    process.env.BROWSERBASE_AUTH_CONTEXT_PROVIDERS || 'nextrequest,justfoia,govqa'
);
const DEFAULT_BROWSERBASE_BLOCK_ASSET_PROVIDERS = parseCsvSet(
    process.env.BROWSERBASE_BLOCK_ASSET_PROVIDERS || 'formcenter'
);
const DEFAULT_BROWSERBASE_PROXY_PROVIDERS = parseCsvSet(
    process.env.BROWSERBASE_PROXY_PROVIDERS || ''
);
const DEFAULT_BROWSERBASE_PROXY_DOMAINS = parseCsvSet(
    process.env.BROWSERBASE_PROXY_DOMAINS || ''
);
const DEFAULT_BROWSERBASE_PROXY_COUNTRY = String(process.env.BROWSERBASE_PROXY_COUNTRY || '').trim().toUpperCase();

function shouldUseBrowserbaseAuthContext(provider, portalUrl, { authOnly = false, force = false } = {}) {
    if (force || authOnly) return true;
    const normalizedProvider = normalizeProviderName(provider, portalUrl);
    return DEFAULT_BROWSERBASE_AUTH_CONTEXT_PROVIDERS.has(normalizedProvider);
}

function buildBrowserbaseProxyPolicy(portalUrl, provider, enabled = false) {
    if (!enabled) return false;
    const normalizedProvider = normalizeProviderName(provider, portalUrl);
    const providerMatch = DEFAULT_BROWSERBASE_PROXY_PROVIDERS.has(normalizedProvider);
    const domainMatch = hostMatchesSet(portalUrl, DEFAULT_BROWSERBASE_PROXY_DOMAINS);
    if (!providerMatch && !domainMatch) {
        return false;
    }

    if (!DEFAULT_BROWSERBASE_PROXY_COUNTRY) {
        return true;
    }

    return [{
        type: 'browserbase',
        geolocation: {
            country: DEFAULT_BROWSERBASE_PROXY_COUNTRY,
        },
    }];
}

function buildBrowserbaseCostPolicy({
    provider = null,
    portalUrl = null,
    mode = 'submit',
    authOnly = false,
    contextId = null,
    advancedStealth = DEFAULT_BROWSERBASE_ADVANCED_STEALTH,
    solveCaptchas = DEFAULT_BROWSERBASE_SOLVE_CAPTCHAS,
    proxies = DEFAULT_BROWSERBASE_PROXIES,
    keepAlive = DEFAULT_BROWSERBASE_KEEP_ALIVE,
    blockAds = DEFAULT_BROWSERBASE_BLOCK_ADS,
} = {}) {
    const normalizedProvider = normalizeProviderName(provider, portalUrl);
    const useAuthContext = shouldUseBrowserbaseAuthContext(normalizedProvider, portalUrl, { authOnly });
    const keepAliveEnabled = useAuthContext || (
        Boolean(keepAlive) && (
            authOnly ||
            mode === 'auth' ||
            mode === 'intervention'
        )
    );
    const blockResourceTypes = DEFAULT_BROWSERBASE_BLOCK_ASSET_PROVIDERS.has(normalizedProvider)
        ? ['image', 'media', 'font']
        : [];

    return {
        provider: normalizedProvider,
        useAuthContext,
        persistContext: useAuthContext,
        keepAlive: keepAliveEnabled,
        blockAds: Boolean(blockAds),
        blockResourceTypes,
        solveCaptchas: Boolean(solveCaptchas),
        advancedStealth: Boolean(advancedStealth),
        proxies: buildBrowserbaseProxyPolicy(portalUrl, normalizedProvider, Boolean(proxies)),
        contextId: contextId || null,
    };
}

function isBrowserbaseAuthInterventionState(value) {
    const normalized = String(typeof value === 'string' ? value : value?.status || '')
        .trim()
        .toLowerCase();
    return [
        'auth_intervention_required',
        'totp_required',
        'external_auth_required',
        'verification_required',
        'auth_required',
    ].includes(normalized);
}

function buildBrowserbaseLaunchOptions({
    projectId = process.env.BROWSERBASE_PROJECT_ID || undefined,
    region = DEFAULT_BROWSERBASE_REGION,
    timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
    advancedStealth = parseBoolean(process.env.BROWSERBASE_ADVANCED_STEALTH, false),
    solveCaptchas = parseBoolean(process.env.BROWSERBASE_SOLVE_CAPTCHAS, true),
    proxies = parseBoolean(process.env.BROWSERBASE_PROXIES, false),
    keepAlive = parseBoolean(process.env.BROWSERBASE_KEEP_ALIVE, false),
    blockAds = parseBoolean(process.env.BROWSERBASE_BLOCK_ADS, false),
    os = process.env.BROWSERBASE_OS || '',
    caseId = null,
    runId = null,
    workerJobId = null,
    provider = null,
    label = null,
    mode = null,
    contextId = null,
    persistContext = false,
} = {}) {
    const browserOs = coerceBrowserbaseOs(os, advancedStealth);
    const launchOptions = {
        projectId,
        region,
        keepAlive: Boolean(keepAlive),
        timeout: Math.ceil(Math.max(1000, Number(timeoutMs) || DEFAULT_NAVIGATION_TIMEOUT_MS) / 1000) + 30,
        proxies: Array.isArray(proxies) ? proxies : (proxies ? true : false),
        browserSettings: {
            advancedStealth: Boolean(advancedStealth),
            blockAds: Boolean(blockAds),
            logSession: true,
            os: browserOs,
            recordSession: true,
            solveCaptchas: Boolean(solveCaptchas),
            viewport: {
                width: 1440,
                height: 1200,
            },
        },
        userMetadata: {
            source: 'autobot-playwright-service',
            caseId: caseId != null ? String(caseId) : '',
            runId: runId != null ? String(runId) : '',
            workerJobId: workerJobId != null ? String(workerJobId) : '',
            mode: String(mode || ''),
            provider: String(provider || 'unknown'),
            target: slugify(label || provider || `case-${caseId || 'unknown'}`),
        },
    };

    if (contextId) {
        launchOptions.browserSettings.context = {
            id: contextId,
            persist: Boolean(persistContext),
        };
    }

    return launchOptions;
}

const DEFAULT_BROWSER_BACKEND = resolveBrowserBackendSelection(process.env.PLAYWRIGHT_BROWSER_BACKEND || 'auto');
const DEFAULT_BROWSERBASE_ADVANCED_STEALTH = parseBoolean(process.env.BROWSERBASE_ADVANCED_STEALTH, false);
const DEFAULT_BROWSERBASE_SOLVE_CAPTCHAS = parseBoolean(process.env.BROWSERBASE_SOLVE_CAPTCHAS, true);
const DEFAULT_BROWSERBASE_PROXIES = parseBoolean(process.env.BROWSERBASE_PROXIES, false);
const DEFAULT_BROWSERBASE_KEEP_ALIVE = parseBoolean(process.env.BROWSERBASE_KEEP_ALIVE, false);
const DEFAULT_BROWSERBASE_BLOCK_ADS = parseBoolean(process.env.BROWSERBASE_BLOCK_ADS, false);
const DEFAULT_BROWSERBASE_OS = coerceBrowserbaseOs(process.env.BROWSERBASE_OS, DEFAULT_BROWSERBASE_ADVANCED_STEALTH);

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function slugify(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'unknown';
}

function attrSelector(attribute, value) {
    const safeValue = String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
    return `[${attribute}="${safeValue}"]`;
}

function truncate(value, max = 160) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[’'`´]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitName(fullName) {
    const trimmed = String(fullName || '').trim();
    if (!trimmed) return { firstName: '', lastName: '' };
    const parts = trimmed.split(/\s+/);
    return {
        firstName: parts[0] || '',
        lastName: parts.slice(1).join(' '),
    };
}

function formatDateForInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function normalizeProviderName(provider, portalUrl = null) {
    const raw = String(provider || '').trim().toLowerCase();
    if (raw.includes('govqa') || raw.includes('custhelp') || raw.includes('mycusthelp')) return 'govqa';
    if (raw.includes('nextrequest')) return 'nextrequest';
    if (raw.includes('justfoia')) return 'justfoia';
    if (raw.includes('civicplus') || raw.includes('form center') || raw.includes('formcenter')) return 'formcenter';
    if (raw.includes('smartsheet')) return 'smartsheet';
    if (raw.includes('coplogic')) return 'coplogic';

    const detected = detectPortalProviderByUrl(portalUrl);
    if (detected?.name) {
        return normalizeProviderName(detected.name, null);
    }

    const normalizedUrl = String(portalUrl || '').toLowerCase();
    if (normalizedUrl.includes('/formcenter/') || normalizedUrl.includes('formcenter')) return 'formcenter';
    if (normalizedUrl.includes('smartsheet.com')) return 'smartsheet';
    if (normalizedUrl.includes('coplogic.com')) return 'coplogic';
    return 'generic';
}

function isSupportedPlaywrightUrl(url, providerHint, lastPortalStatus = null) {
    if (!url) return false;
    const normalizedProvider = normalizeProviderName(providerHint, url);
    if (['govqa', 'nextrequest', 'justfoia', 'formcenter', 'smartsheet', 'coplogic'].includes(normalizedProvider)) {
        return isSupportedPortalUrl(url, normalizedProvider, lastPortalStatus);
    }
    return isSupportedPortalUrl(url, providerHint, lastPortalStatus);
}

function scoreGovQaRequestLink(agencyName, linkText) {
    const agency = normalizeText(agencyName);
    const text = normalizeText(linkText);
    if (!text) return -1;

    let score = 0;
    const agencyTokens = agency.split(' ').filter(Boolean);
    const textTokens = text.split(' ').filter(Boolean);

    for (const token of agencyTokens) {
        if (token.length < 3) continue;
        if (textTokens.includes(token)) score += 4;
        else if (text.includes(token)) score += 2;
    }

    if (agency.includes('police') && text.includes('police')) score += 8;
    if (agency.includes('sheriff') && text.includes('sheriff')) score += 8;
    if (agency.includes('fire') && text.includes('fire')) score += 5;
    if (text.includes('open records request')) score += 3;
    if (text.includes('submit')) score += 1;

    return score;
}

function scoreJustFoiaLaunchLink(linkText) {
    const text = normalizeText(linkText);
    if (!text) return -1;

    let score = 0;
    if (text.includes('public records request')) score += 10;
    if (text.includes('records request')) score += 6;
    if (text.includes('public records')) score += 4;
    if (text.includes('background check')) score -= 4;
    if (text.includes('deposition')) score -= 4;
    if (text.includes('other agency')) score -= 3;
    if (text.includes('state attorney')) score -= 3;
    return score;
}

function scoreSubmitControlCandidates(controls = []) {
    return controls
        .filter((control) => control.visible && !control.disabled)
        .map((control) => {
            const text = normalizeText([
                control.text,
                control.id,
                control.name,
                control.ariaLabel,
                control.className,
            ].filter(Boolean).join(' '));

            let score = -10;
            if (!text) score = -20;
            if (/\bsubmit request\b|\bsubmit form\b|\bsubmit\b/.test(text)) score = 24;
            if (/\bsend request\b|\bsend form\b|\bsend\b/.test(text)) score = Math.max(score, 20);
            if (/\bcreate request\b|\bmake request\b/.test(text)) score = Math.max(score, 22);
            if (/\bcontinue\b/.test(text)) score = Math.max(score, 14);
            if (/\bnext\b/.test(text)) score = Math.max(score, 10);
            if (/\bbtnformsubmit\b|\bformsubmit\b/.test(text)) score = Math.max(score, 26);
            if (control.tag === 'a' && /\bmodern button\b/.test(text)) score = Math.max(score, 12);
            if (/\bsearch\b|\blog in\b|\bsign in\b|\breset\b|\bcancel\b|\bclose\b|\bback\b|\bprint\b/.test(text)) score = -20;

            return { ...control, score };
        })
        .sort((left, right) => right.score - left.score);
}

function isCaptchaLikeField(field = {}) {
    const haystack = normalizeText([
        field.label,
        field.placeholder,
        field.ariaLabel,
        field.name,
        field.id,
    ].filter(Boolean).join(' '));

    if (!haystack) return false;
    return /\bcaptcha\b|\bsecurity code\b|\bverification code\b|\bverify you are human\b|\benter the characters\b|\benter the code shown\b|\btype the characters\b/.test(haystack);
}

function buildRequestNarrative(caseData, requester) {
    const requestedRecords = Array.isArray(caseData?.requested_records)
        ? caseData.requested_records.filter(Boolean).join(', ')
        : String(caseData?.requested_records || '').trim();
    const subject = caseData?.subject_name || caseData?.case_name || 'the named subject';
    const incidentDate = formatDateForInput(caseData?.incident_date) || 'the relevant incident date';
    const incidentLocation = caseData?.incident_location || 'the relevant incident location';
    const extra = String(caseData?.additional_details || '').trim();
    const requesterName = requester?.name || process.env.REQUESTER_NAME || 'Requester';

    return [
        `This is a public records request submitted by ${requesterName}.`,
        requestedRecords ? `Requested records: ${requestedRecords}.` : null,
        `The request concerns ${subject}.`,
        `Relevant date: ${incidentDate}.`,
        `Relevant location: ${incidentLocation}.`,
        extra ? `Additional details: ${extra}` : null,
    ].filter(Boolean).join(' ');
}

function buildRequesterProfile(caseData, user = null) {
    const hasCaseRequesterAddress =
        Boolean(caseData?.requester_address) ||
        Boolean(caseData?.requester_city) ||
        Boolean(caseData?.requester_state) ||
        Boolean(caseData?.requester_zip);

    const fullName = user?.signature_name || user?.name || caseData?.requester_name || process.env.REQUESTER_NAME || 'Requester';
    const split = splitName(fullName);

    return {
        name: fullName,
        firstName: split.firstName || 'Requester',
        lastName: split.lastName || 'User',
        email: user?.email || caseData?.requester_email || process.env.REQUESTER_EMAIL || process.env.REQUESTS_INBOX || 'requests@foib-request.com',
        phone: user?.signature_phone || caseData?.requester_phone || process.env.REQUESTER_PHONE || '209-800-7702',
        organization: user
            ? (user.signature_organization ?? '')
            : (caseData?.requester_organization || process.env.REQUESTER_ORG || ''),
        title: user?.signature_title || caseData?.requester_title || process.env.REQUESTER_TITLE || '',
        address: user?.address_street || caseData?.requester_address || process.env.REQUESTER_ADDRESS || '3021 21st Ave W',
        addressLine2: user?.address_street2 || caseData?.requester_address_line2 || process.env.REQUESTER_ADDRESS_LINE2 || 'Apt 202',
        city: user?.address_city || caseData?.requester_city || process.env.REQUESTER_CITY || 'Seattle',
        state: user?.address_state || caseData?.requester_state || process.env.REQUESTER_STATE || (hasCaseRequesterAddress ? '' : 'WA'),
        zip: user?.address_zip || caseData?.requester_zip || process.env.REQUESTER_ZIP || '98199',
    };
}

function buildPortalCredentialProfile(requester, portalAccount = null) {
    return {
        email: portalAccount?.email || requester.email,
        password: portalAccount?.password || process.env.PORTAL_DEFAULT_PASSWORD || 'Insanity10M',
        firstName: portalAccount?.first_name || requester.firstName || splitName(requester.name).firstName || 'Requester',
        lastName: portalAccount?.last_name || requester.lastName || splitName(requester.name).lastName || 'User',
    };
}

function buildPortalActionUrl(portalUrl, actionPath) {
    const normalizedUrl = normalizePortalUrl(portalUrl);
    if (!normalizedUrl) return actionPath;

    try {
        const origin = new URL(normalizedUrl).origin;
        return new URL(actionPath, origin).toString();
    } catch (_) {
        return actionPath;
    }
}

function inferNextRequestLinkKind(link) {
    const normalized = String(link || '').toLowerCase();
    if (normalized.includes('/users/unlock')) return 'unlock';
    if (normalized.includes('/users/confirmation')) return 'confirmation';
    if (normalized.includes('/users/password/edit')) return 'password_reset';
    return 'magic_link';
}

function mapFieldValue(field, { caseData, requester, portalAccount, pageKind }) {
    const label = normalizeText([
        field.label,
        field.ariaLabel,
        field.placeholder,
        field.name,
        field.id,
    ].filter(Boolean).join(' '));
    const isGenericNameField =
        /\bname\b/.test(label) &&
        !label.includes('first name') &&
        !label.includes('last name') &&
        !label.includes('company') &&
        !label.includes('organization') &&
        !label.includes('user name') &&
        !label.includes('username');

    if (!label) return null;
    if (label.includes('search')) return null;
    if (label.includes('captcha') || label.includes('verify you are human')) return null;
    if (label.includes('email copy') || label.includes('not part of the form submission')) return null;

    if (pageKind === 'auth_page') {
        if ((label.includes('email') || field.type === 'email') && portalAccount?.email) {
            return portalAccount.email;
        }
        if ((label.includes('password') || field.type === 'password') && portalAccount?.password) {
            return portalAccount.password;
        }
        return null;
    }

    if (field.type === 'password') return null;
    if ((label.includes('email') || field.type === 'email') && !label.includes('copy')) {
        return requester.email;
    }
    if (label.includes('first name')) return requester.firstName;
    if (label.includes('last name')) return requester.lastName;
    if (label.includes('full name') || label.endsWith('your name') || label.includes('contact name') || isGenericNameField) return requester.name;
    if (label.includes('phone')) return requester.phone;
    if (label.includes('address1') || label.includes('street address') || label === 'address' || label.includes('mailing address')) {
        return requester.address;
    }
    if (label.includes('address2') || label.includes('line 2') || label.includes('apt')) {
        return requester.addressLine2;
    }
    if (label.includes('audio statements')) return 'Requested if available';
    if (label.includes('photos')) return 'Requested if available';
    if (label.includes('citation')) return 'Not applicable if none';
    if (label.includes('city')) return requester.city;
    if (label === 'state' || label.startsWith('state ') || label.endsWith(' state') || /\bstate\b/.test(label)) return requester.state;
    if (label.includes('zip')) return requester.zip;
    if (label.includes('organization') || label.includes('company')) return requester.organization;
    if (label.includes('title')) return requester.title;

    if (label.includes('nature of report')) {
        return Array.isArray(caseData?.requested_records) && caseData.requested_records.length > 0
            ? caseData.requested_records[0]
            : 'Police report';
    }
    if (label.includes('case number') || label.includes('report number')) return '';
    if (label.includes('date start') || label.includes('date end') || label === 'date' || label.includes('incident date')) {
        return formatDateForInput(caseData?.incident_date);
    }
    if (label.includes('location of report') || label.includes('incident location') || label.includes('address of report')) {
        return caseData?.incident_location || '';
    }
    if (label.includes('person or persons involved') || label.includes('subject') || label.includes('person of interest')) {
        return caseData?.subject_name || caseData?.case_name || '';
    }
    if (label.includes('other information') || label.includes('request description') || label.includes('description') || label.includes('details') || label.includes('information sought') || label.includes('request')) {
        return buildRequestNarrative(caseData, requester);
    }
    if (label.includes('police reports') || label.includes('supplements')) return 'Requested';
    if (label.includes('calls for service')) return 'Requested';

    if (field.type === 'checkbox') {
        if (label.includes('agree') || label.includes('acknowledge') || label.includes('consent')) {
            return true;
        }
        return null;
    }

    if (field.tag === 'select' && Array.isArray(field.options) && field.options.length > 0) {
        const normalizedOptions = field.options.map((option) => normalizeText(option.text || option.value));
        if (normalizedOptions.includes(normalizeText(requester.state))) return requester.state;
        if (normalizedOptions.includes('electronic')) return 'Electronic';
        if (normalizedOptions.includes('email')) return 'Email';
    }

    return null;
}

class PortalAgentServicePlaywright {
    constructor(options = {}) {
        this.headless = options.headless ?? DEFAULT_HEADLESS;
        this.slowMo = options.slowMo ?? DEFAULT_SLOW_MO_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
        this.artifactsRoot = options.artifactsRoot || DEFAULT_ARTIFACTS_ROOT;
        this.browserBackend = normalizeBrowserBackend(options.browserBackend ?? DEFAULT_BROWSER_BACKEND);
        this.browserbaseRegion = options.browserbaseRegion || DEFAULT_BROWSERBASE_REGION;
        this.browserbaseProjectId = options.browserbaseProjectId || process.env.BROWSERBASE_PROJECT_ID || null;
        this.browserbaseAdvancedStealth = options.browserbaseAdvancedStealth ?? DEFAULT_BROWSERBASE_ADVANCED_STEALTH;
        this.browserbaseSolveCaptchas = options.browserbaseSolveCaptchas ?? DEFAULT_BROWSERBASE_SOLVE_CAPTCHAS;
        this.browserbaseProxies = options.browserbaseProxies ?? DEFAULT_BROWSERBASE_PROXIES;
        this.browserbaseKeepAlive = options.browserbaseKeepAlive ?? DEFAULT_BROWSERBASE_KEEP_ALIVE;
        this.browserbaseBlockAds = options.browserbaseBlockAds ?? DEFAULT_BROWSERBASE_BLOCK_ADS;
        this.browserbaseOs = options.browserbaseOs || DEFAULT_BROWSERBASE_OS;
    }

    _resolveBrowserBackend(options = {}) {
        return resolveBrowserBackendSelection(
            options.browserBackend ?? this.browserBackend,
            Boolean(options.browserbaseApiKey || process.env.BROWSERBASE_API_KEY)
        );
    }

    _resolveEngineName(browserBackend, dryRun) {
        if (browserBackend === 'browserbase') {
            return dryRun ? 'playwright_browserbase_dry_run' : 'playwright_browserbase';
        }
        return dryRun ? 'playwright_dry_run' : 'playwright_local';
    }

    async _launchBrowserRuntime(caseData, summary, options = {}) {
        const browserBackend = summary.browser_backend || this._resolveBrowserBackend(options);
        if (browserBackend === 'browserbase') {
            return this._launchBrowserbaseRuntime(caseData, summary, options);
        }
        return this._launchLocalRuntime(options);
    }

    async _launchLocalRuntime(options = {}) {
        const browser = await chromium.launch({
            headless: options.headless ?? this.headless,
            slowMo: options.slowMo ?? this.slowMo,
        });
        const context = await browser.newContext({
            viewport: { width: 1440, height: 1200 },
            ignoreHTTPSErrors: true,
        });

        return {
            backend: 'local',
            browser,
            context,
            browserSessionId: null,
            browserSessionUrl: null,
            close: async () => {
                await context.close().catch(() => {});
                await browser.close().catch(() => {});
            },
        };
    }

    async _launchBrowserbaseRuntime(caseData, summary, options = {}) {
        const apiKey = options.browserbaseApiKey || process.env.BROWSERBASE_API_KEY;
        if (!apiKey) {
            throw new Error('BROWSERBASE_API_KEY is required when PLAYWRIGHT_BROWSER_BACKEND=browserbase');
        }

        const { default: Browserbase } = await import('@browserbasehq/sdk');
        const client = new Browserbase({ apiKey });
        const projectId = options.browserbaseProjectId || this.browserbaseProjectId || undefined;
        const browserbaseCostPolicy = options.browserbaseCostPolicy || buildBrowserbaseCostPolicy({
            provider: summary.provider || caseData?.portal_provider || null,
            portalUrl: summary.portalUrl || null,
            mode: options.mode || summary.mode || 'submit',
            authOnly: options.authOnly === true,
            contextId: options.browserbaseContextId || null,
            advancedStealth: options.browserbaseAdvancedStealth ?? this.browserbaseAdvancedStealth,
            solveCaptchas: options.browserbaseSolveCaptchas ?? this.browserbaseSolveCaptchas,
            proxies: options.browserbaseProxies ?? this.browserbaseProxies,
            keepAlive: options.browserbaseKeepAlive ?? this.browserbaseKeepAlive,
            blockAds: options.browserbaseBlockAds ?? this.browserbaseBlockAds,
        });

        let session = null;
        let sessionParams = null;
        let reusedSession = false;
        let contextId = options.browserbaseContextId || browserbaseCostPolicy.contextId || null;

        if (options.browserbaseSessionId) {
            const existingSession = await client.sessions.retrieve(options.browserbaseSessionId);
            if (!existingSession?.connectUrl) {
                throw new Error(`Browserbase session ${options.browserbaseSessionId} is not reconnectable`);
            }
            session = existingSession;
            reusedSession = true;
            contextId = existingSession.contextId || contextId || null;
        } else {
            if (browserbaseCostPolicy.useAuthContext && !contextId) {
                const createdContext = await client.contexts.create({
                    projectId,
                });
                contextId = createdContext?.id || null;
            }

            sessionParams = buildBrowserbaseLaunchOptions({
                projectId,
                region: options.browserbaseRegion || this.browserbaseRegion,
                timeoutMs: options.timeoutMs ?? this.timeoutMs,
                advancedStealth: browserbaseCostPolicy.advancedStealth,
                solveCaptchas: browserbaseCostPolicy.solveCaptchas,
                proxies: browserbaseCostPolicy.proxies,
                keepAlive: browserbaseCostPolicy.keepAlive,
                blockAds: browserbaseCostPolicy.blockAds,
                os: options.browserbaseOs || this.browserbaseOs,
                caseId: caseData?.id || null,
                runId: summary.runId || null,
                workerJobId: options.workerJobId || null,
                provider: summary.provider || caseData?.portal_provider || null,
                label: caseData?.agency_name || caseData?.case_name || summary.portalUrl || null,
                mode: options.mode || summary.mode || 'submit',
                contextId,
                persistContext: browserbaseCostPolicy.persistContext,
            });

            session = await this._createBrowserbaseSessionWithFallback(client, sessionParams);
            contextId = session?.contextId || contextId || null;
        }

        const liveUrls = await client.sessions.debug(session.id).catch(() => null);
        const browser = await chromium.connectOverCDP(session.connectUrl);
        const context = browser.contexts()[0] || await browser.newContext({
            viewport: { width: 1440, height: 1200 },
            ignoreHTTPSErrors: true,
        });

        if (browserbaseCostPolicy.blockResourceTypes?.length) {
            await this._installBrowserCostControls(context, browserbaseCostPolicy);
        }

        return {
            backend: 'browserbase',
            browser,
            context,
            browserSessionId: session.id,
            browserSessionUrl: buildBrowserbaseSessionUrl(session.id),
            browserDebuggerUrl: liveUrls?.debuggerUrl || null,
            browserDebuggerFullscreenUrl: liveUrls?.debuggerFullscreenUrl || null,
            browserLiveUrls: liveUrls?.pages || [],
            browserRegion: session.region || sessionParams?.region || null,
            browserStatus: session.status || null,
            browserMetadata: session.userMetadata || sessionParams?.userMetadata || {},
            browserContextId: contextId,
            browserKeepAlive: Boolean(sessionParams?.keepAlive || browserbaseCostPolicy.keepAlive),
            browserCostPolicy: browserbaseCostPolicy,
            reusedSession,
            close: async () => {
                await browser.close().catch(() => {});
                if ((options.preserveBrowserSession || summary.preserve_browser_session) && session?.id) {
                    return;
                }
                if (session?.id) {
                    await client.sessions.update(session.id, {
                        status: 'REQUEST_RELEASE',
                        projectId,
                    }).catch(() => null);
                }
            },
        };
    }

    async _createBrowserbaseSessionWithFallback(client, initialParams) {
        let sessionParams = initialParams;
        let metadataReduced = false;
        let proxiesDisabled = sessionParams.proxies === false;
        let advancedDisabled = sessionParams.browserSettings?.advancedStealth === false;

        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                return await client.sessions.create(sessionParams);
            } catch (error) {
                const message = String(error?.message || error || '');
                if (!metadataReduced && /not a valid metadata value/i.test(message)) {
                    metadataReduced = true;
                    sessionParams = {
                        ...sessionParams,
                        userMetadata: {
                            source: sessionParams.userMetadata?.source || 'autobot-playwright-service',
                            caseId: sessionParams.userMetadata?.caseId || '',
                            provider: sessionParams.userMetadata?.provider || 'unknown',
                        },
                    };
                    continue;
                }
                if (!proxiesDisabled && /proxies are not included/i.test(message)) {
                    proxiesDisabled = true;
                    sessionParams = {
                        ...sessionParams,
                        proxies: false,
                    };
                    continue;
                }
                if (!advancedDisabled && /advancedstealth|advanced stealth/i.test(message)) {
                    advancedDisabled = true;
                    sessionParams = {
                        ...sessionParams,
                        browserSettings: {
                            ...sessionParams.browserSettings,
                            advancedStealth: false,
                            os: 'linux',
                        },
                    };
                    continue;
                }
                throw error;
            }
        }

        return client.sessions.create(sessionParams);
    }

    async _installBrowserCostControls(context, browserbaseCostPolicy = {}) {
        const blockedResourceTypes = Array.isArray(browserbaseCostPolicy.blockResourceTypes)
            ? browserbaseCostPolicy.blockResourceTypes
            : [];
        if (blockedResourceTypes.length === 0) return;

        const blockedTypeSet = new Set(blockedResourceTypes.map((value) => String(value).toLowerCase()));
        await context.route('**/*', async (route) => {
            const request = route.request();
            const resourceType = String(request.resourceType() || '').toLowerCase();
            if (blockedTypeSet.has(resourceType)) {
                return route.abort().catch(() => null);
            }
            return route.continue().catch(() => null);
        }).catch(() => null);
    }

    async submitToPortal(caseData, portalUrl, options = {}) {
        return this._runPortal(caseData, portalUrl, {
            ...options,
            mode: 'submit',
            dryRun: options.dryRun !== false,
        });
    }

    async checkPortalStatus(caseData, portalUrl, options = {}) {
        return this._runPortal(caseData, portalUrl, {
            ...options,
            mode: 'status',
            dryRun: true,
            statusOnly: true,
        });
    }

    async preparePortalSession(caseData, portalUrl, options = {}) {
        return this._runPortal(caseData, portalUrl, {
            ...options,
            mode: 'auth',
            dryRun: true,
            authOnly: true,
            ensureAccount: options.ensureAccount !== false,
            forceAccountSetup: options.forceAccountSetup !== false,
        });
    }

    async validatePortal(caseData, portalUrl, options = {}) {
        return this._runPortal(caseData, portalUrl, {
            ...options,
            mode: 'validate',
            dryRun: true,
            trackInAutobot: false,
            ensureAccount: false,
            forceAccountSetup: false,
        });
    }

    async _runPortal(caseData, portalUrl, options = {}) {
        const normalizedUrl = normalizePortalUrl(portalUrl);
        const providerHint = normalizeProviderName(caseData?.portal_provider, normalizedUrl);
        const browserBackend = this._resolveBrowserBackend(options);
        const runId = crypto.randomUUID();
        const artifactsDir = ensureDir(
            path.join(
                options.artifactsRoot || this.artifactsRoot,
                `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(providerHint)}-case-${caseData?.id || 'unknown'}`
            )
        );

        const summary = {
            success: false,
            dryRun: options.dryRun !== false,
            mode: options.mode || 'submit',
            engine: this._resolveEngineName(browserBackend, options.dryRun !== false),
            provider: providerHint,
            runId,
            caseId: caseData?.id || null,
            portalUrl: normalizedUrl,
            browser_backend: browserBackend,
            browser_session_id: null,
            browser_session_url: null,
            browser_debugger_url: null,
            browser_debugger_fullscreen_url: null,
            browser_region: null,
            browser_status: null,
            browser_metadata: {},
            browser_live_urls_jsonb: {},
            auth_context_id: null,
            auth_intervention_status: null,
            auth_intervention_reason: null,
            auth_intervention_requested_at: null,
            auth_intervention_completed_at: null,
            browser_keep_alive: false,
            browser_cost_policy: {},
            preserve_browser_session: false,
            accountEmail: null,
            status: 'initialized',
            blockers: [],
            steps: [],
            artifactsDir,
            taskId: null,
            recording_url: null,
            screenshot_url: null,
            extracted_data: null,
            final_url: normalizedUrl,
            final_title: null,
            confirmationNumber: null,
            submissionAttempted: false,
            submissionConfirmed: false,
            fallback_safe: true,
            scout: null,
        };
        const shouldTrackInAutobot = options.trackInAutobot ?? (Boolean(summary.caseId) && (!summary.dryRun || DEFAULT_TRACK_IN_AUTOBOT));

        if (!normalizedUrl || !isSupportedPlaywrightUrl(normalizedUrl, providerHint, caseData?.last_portal_status)) {
            summary.status = 'unsupported_portal';
            summary.error = 'Portal URL is missing or currently flagged as unsupported';
            const unsupportedSubmission = await this._startTrackedRun(caseData, summary, shouldTrackInAutobot).catch(() => null);
            await this._finalizeTrackedRun(caseData, summary, unsupportedSubmission, shouldTrackInAutobot).catch(() => {});
            await this._writeJson(path.join(artifactsDir, 'summary.json'), summary);
            return summary;
        }

        let browser = null;
        let context = null;
        let page = null;
        let browserRuntime = null;
        let tracingStarted = false;
        let submissionRow = null;

        try {
            const caseOwner = caseData?.user_id ? await database.getUserById(caseData.user_id).catch(() => null) : null;
            const requester = buildRequesterProfile(caseData, caseOwner);
            let portalAccount = await database
                .getPortalAccountByUrl(normalizedUrl, caseData?.user_id || null, { includeInactive: true })
                .catch(() => null);
            if (portalAccount?.account_status === 'no_account_needed') {
                summary.accountEmail = null;
                portalAccount = null;
            } else {
                summary.accountEmail = portalAccount?.email || requester.email || null;
            }
            const credentialProfile = buildPortalCredentialProfile(requester, portalAccount);
            submissionRow = await this._startTrackedRun(caseData, summary, shouldTrackInAutobot).catch(() => null);

            browserRuntime = await this._launchBrowserRuntime(caseData, summary, {
                ...options,
                browserBackend,
            });
            browser = browserRuntime.browser;
            context = browserRuntime.context;
            summary.browser_session_id = browserRuntime.browserSessionId || null;
            summary.browser_session_url = browserRuntime.browserSessionUrl || null;
            summary.browser_debugger_url = browserRuntime.browserDebuggerUrl || null;
            summary.browser_debugger_fullscreen_url = browserRuntime.browserDebuggerFullscreenUrl || null;
            summary.browser_region = browserRuntime.browserRegion || null;
            summary.browser_status = browserRuntime.browserStatus || null;
            summary.browser_metadata = browserRuntime.browserMetadata || {};
            summary.browser_live_urls_jsonb = browserRuntime.browserLiveUrls
                ? { pages: browserRuntime.browserLiveUrls }
                : {};
            summary.auth_context_id = browserRuntime.browserContextId || null;
            summary.browser_keep_alive = Boolean(browserRuntime.browserKeepAlive);
            summary.browser_cost_policy = browserRuntime.browserCostPolicy || {};
            if (summary.browser_session_url) {
                summary.recording_url = summary.browser_session_url;
            }
            await this._persistTrackedBrowserSession(caseData, summary, submissionRow, shouldTrackInAutobot).catch(() => {});

            context.setDefaultTimeout(options.timeoutMs ?? this.timeoutMs);
            context.setDefaultNavigationTimeout(options.timeoutMs ?? this.timeoutMs);
            await context.tracing.start({ screenshots: true, snapshots: true, sources: false }).then(() => {
                tracingStarted = true;
            }).catch(() => {
                tracingStarted = false;
            });

            const existingPage = browserRuntime.reusedSession
                ? (context.pages()[context.pages().length - 1] || context.pages()[0] || null)
                : null;
            page = existingPage || await context.newPage();
            await page.setViewportSize({ width: 1440, height: 1200 }).catch(() => {});
            const shouldResumeCurrentPage = Boolean(browserRuntime.reusedSession && existingPage && options.browserbaseSessionId);
            if (!shouldResumeCurrentPage) {
                await this._goto(page, normalizedUrl, { initialLoad: true, providerHint });
                summary.steps.push({ step: 'goto', url: page.url(), title: await page.title() });
            } else {
                summary.steps.push({ step: 'resume_browserbase_session', sessionId: summary.browser_session_id, url: page.url(), title: await page.title() });
            }
            summary.final_url = page.url();

            await this._writeText(path.join(artifactsDir, 'initial.html'), await this._safePageContent(page));
            const initialScreenshotPath = path.join(artifactsDir, 'initial.png');
            await page.screenshot({ path: initialScreenshotPath, fullPage: true }).catch(() => {});
            await this._persistTrackedScreenshot(summary, {
                sourcePath: initialScreenshotPath,
                sequenceIndex: 0,
                label: 'Playwright initial portal state',
                status: 'started',
            });

            const provider = await this._detectProvider(page, normalizedUrl, caseData?.portal_provider);
            summary.provider = provider;

            if (provider === 'nextrequest' && (options.ensureAccount || options.authOnly)) {
                const authPreparation = await this._ensureNextRequestAccountAccess(page, normalizedUrl, {
                    caseData,
                    requester,
                    existingAccount: portalAccount,
                    credentials: credentialProfile,
                    authOnly: options.authOnly,
                    forceAccountSetup: options.forceAccountSetup === true,
                });
                if (authPreparation?.step) {
                    summary.steps.push(authPreparation.step);
                }
                if (authPreparation?.accountEmail) {
                    summary.accountEmail = authPreparation.accountEmail;
                }
                if (authPreparation?.portalAccount) {
                    portalAccount = authPreparation.portalAccount;
                }
                if (authPreparation?.blocker) {
                    if (browserBackend === 'browserbase' && isBrowserbaseAuthInterventionState(authPreparation.blocker)) {
                        await this._markAuthInterventionRequired(
                            summary,
                            page,
                            portalAccount,
                            authPreparation.blocker.reason || 'Portal authentication needs operator help',
                            authPreparation.blocker.status
                        );
                    } else {
                        summary.status = authPreparation.blocker.status;
                        summary.blockers.push(authPreparation.blocker);
                        summary.final_url = page.url();
                        summary.success = false;
                        summary.extracted_data = authPreparation.extracted_data || null;
                    }
                    return summary;
                }
                if (summary.auth_context_id && portalAccount) {
                    await this._syncPortalAccountBrowserbaseContext(portalAccount, summary, {
                        contextStatus: authPreparation?.success === false ? 'pending' : 'authenticated',
                        authenticated: authPreparation?.success !== false,
                        metadata: {
                            source: 'nextrequest_auth_preparation',
                            auth_status: authPreparation?.status || null,
                        },
                    }).catch(() => null);
                }
                if (options.authOnly) {
                    summary.status = authPreparation?.status || 'auth_ready';
                    summary.success = authPreparation?.success !== false;
                    summary.final_url = page.url();
                    summary.extracted_data = authPreparation?.extracted_data || null;
                    if (summary.auth_context_id && portalAccount && summary.success) {
                        await this._syncPortalAccountBrowserbaseContext(portalAccount, summary, {
                            contextStatus: 'authenticated',
                            authenticated: true,
                            metadata: {
                                source: 'auth_only_completion',
                                auth_status: summary.status,
                            },
                        }).catch(() => null);
                    }
                    const finalScreenshotPath = path.join(artifactsDir, 'final.png');
                    await page.screenshot({ path: finalScreenshotPath, fullPage: true }).catch(() => {});
                    await this._persistTrackedScreenshot(summary, {
                        sourcePath: finalScreenshotPath,
                        sequenceIndex: 1,
                        label: 'Playwright auth-prep portal state',
                        status: summary.status,
                    });
                    await this._writeText(path.join(artifactsDir, 'final.html'), await this._safePageContent(page));
                    return summary;
                }
            }

            const blockingState = await this._detectBlockingState(page);
            if (blockingState) {
                summary.status = blockingState.status;
                summary.blockers.push(blockingState);
                summary.final_url = page.url();
                summary.success = false;
                await this._maybeRunPortalScout(caseData, page.url(), summary.provider || providerHint, summary, {
                    submissionRow,
                    workerJobId: options.workerJobId || null,
                    reason: blockingState.status,
                });
                return summary;
            }

            const navigation = await this._navigateToWorkSurface(page, provider, caseData, normalizedUrl);
            if (navigation?.step) {
                summary.steps.push(navigation.step);
            }
            if (navigation?.blocker) {
                summary.status = navigation.blocker.status;
                summary.blockers.push(navigation.blocker);
                summary.final_url = page.url();
                summary.success = false;
                await this._maybeRunPortalScout(caseData, page.url(), summary.provider || providerHint, summary, {
                    submissionRow,
                    workerJobId: options.workerJobId || null,
                    reason: navigation.blocker.status,
                });
                return summary;
            }

            const pageKind = await this._detectPageKind(page);
            summary.pageKind = pageKind;
            summary.final_url = page.url();
            summary.steps.push({
                step: 'page_kind',
                kind: pageKind,
                url: page.url(),
                title: await page.title(),
            });

            if (browserBackend === 'browserbase' && pageKind === 'auth_page') {
                await this._markAuthInterventionRequired(
                    summary,
                    page,
                    portalAccount,
                    'Portal requires an interactive sign-in or verification step before submission',
                    'auth_page'
                );
                return summary;
            }

            const fieldAnalysis = await this._analyzeVisibleFields(page);
            summary.fieldAnalysis = {
                totalFields: fieldAnalysis.fields.length,
                visibleFields: fieldAnalysis.visibleFields.length,
            };

            await this._writeJson(path.join(artifactsDir, 'fields.json'), fieldAnalysis.visibleFields);

            const captchaRequirement = await this._detectCaptchaRequirement(page, fieldAnalysis.visibleFields);
            if (captchaRequirement) {
                summary.status = captchaRequirement.status;
                summary.error = captchaRequirement.reason;
                summary.blockers.push(captchaRequirement);
                summary.final_url = page.url();
                summary.success = false;
                await this._maybeRunPortalScout(caseData, page.url(), summary.provider || provider, summary, {
                    submissionRow,
                    workerJobId: options.workerJobId || null,
                    reason: captchaRequirement.status,
                });
                return summary;
            }

            let fillSummary = {
                filled: [],
                skipped: [],
            };

            if (pageKind === 'request_form' && !options.statusOnly) {
                fillSummary = await this._fillVisibleFields(page, fieldAnalysis.visibleFields, {
                    caseData,
                    requester,
                    portalAccount,
                    pageKind,
                });
                if (summary.dryRun) {
                    summary.status = fillSummary.filled.length > 0 ? 'dry_run_form_filled' : 'dry_run_form_detected';
                    summary.success = true;
                } else {
                    const submitOutcome = await this._submitFilledRequest(page, provider);
                    summary.submissionAttempted = Boolean(submitOutcome.attempted);
                    summary.submissionConfirmed = Boolean(submitOutcome.confirmed);
                    summary.fallback_safe = submitOutcome.fallbackSafe !== false;
                    summary.confirmationNumber = submitOutcome.confirmationNumber || null;
                    if (submitOutcome.step) {
                        summary.steps.push(submitOutcome.step);
                    }
                    if (submitOutcome.blocker) {
                        summary.blockers.push(submitOutcome.blocker);
                        summary.error = submitOutcome.blocker.reason || summary.error;
                    }
                    summary.status = submitOutcome.status || 'submission_failed';
                    summary.success = Boolean(submitOutcome.confirmed);
                }
            } else if (pageKind === 'auth_page') {
                fillSummary = await this._fillVisibleFields(page, fieldAnalysis.visibleFields, {
                    caseData,
                    requester,
                    portalAccount,
                    pageKind,
                });
                if (portalAccount?.email && portalAccount?.password && fillSummary.filled.length > 0) {
                    summary.status = 'dry_run_auth_ready';
                    summary.success = true;
                } else {
                    summary.status = 'auth_required';
                    summary.blockers.push({
                        status: 'auth_required',
                        reason: 'Portal requires login or account creation before request submission',
                    });
                    summary.success = false;
                }
            } else if (pageKind === 'landing_page') {
                summary.status = 'landing_page_detected';
                summary.success = true;
            } else {
                summary.status = 'page_detected_unclassified';
                summary.success = false;
                await this._maybeRunPortalScout(caseData, page.url(), summary.provider || provider, summary, {
                    submissionRow,
                    workerJobId: options.workerJobId || null,
                    reason: summary.status,
                });
            }

            summary.fieldsFilled = fillSummary.filled;
            summary.fieldsSkipped = fillSummary.skipped;
            summary.extracted_data = {
                page_kind: pageKind,
                provider,
                visible_fields: fieldAnalysis.visibleFields.length,
                filled_fields: fillSummary.filled.length,
                confirmation_number: summary.confirmationNumber || null,
                submission_attempted: summary.submissionAttempted,
                submission_confirmed: summary.submissionConfirmed,
            };

            const finalScreenshotPath = path.join(artifactsDir, 'final.png');
            await page.screenshot({ path: finalScreenshotPath, fullPage: true }).catch(() => {});
            await this._persistTrackedScreenshot(summary, {
                sourcePath: finalScreenshotPath,
                sequenceIndex: 1,
                label: 'Playwright final portal state',
                status: summary.status,
            });
            await this._writeText(path.join(artifactsDir, 'final.html'), await this._safePageContent(page));
            return summary;
        } catch (error) {
            const errorMessage = error?.message || String(error);
            const looksLikeNavigationTimeout = /page\.goto: Timeout|Timeout .*exceeded/i.test(errorMessage);
            const unreachableOnInitialLoad = page && page.url() === 'about:blank' && looksLikeNavigationTimeout;

            summary.status = unreachableOnInitialLoad ? 'blocked_portal_unreachable' : 'error';
            summary.error = errorMessage;
            summary.success = false;
            if (page) {
                summary.final_url = page.url();
                const errorScreenshotPath = path.join(artifactsDir, 'error.png');
                await page.screenshot({ path: errorScreenshotPath, fullPage: true }).catch(() => {});
                await this._persistTrackedScreenshot(summary, {
                    sourcePath: errorScreenshotPath,
                    sequenceIndex: 1,
                    label: 'Playwright error portal state',
                    status: summary.status,
                });
                await this._writeText(path.join(artifactsDir, 'error.html'), await this._safePageContent(page)).catch(() => {});
            }
            if (unreachableOnInitialLoad) {
                summary.blockers.push({
                    status: 'blocked_portal_unreachable',
                    reason: 'Portal did not establish an initial browser response from this worker',
                });
            }
            await this._maybeRunPortalScout(caseData, summary.final_url || normalizedUrl, summary.provider || providerHint, summary, {
                submissionRow,
                workerJobId: options.workerJobId || null,
                reason: summary.status,
            }).catch(() => null);
            return summary;
        } finally {
            if (page) {
                summary.final_url = page.url() || summary.final_url;
                summary.final_title = await page.title().catch(() => null);
            }
            if (context && tracingStarted) {
                await context.tracing.stop({ path: path.join(artifactsDir, 'trace.zip') }).catch(() => {});
            }
            await this._finalizeTrackedRun(caseData, summary, submissionRow, shouldTrackInAutobot).catch(() => {});
            if (page) await page.close().catch(() => {});
            if (browserRuntime?.close) {
                await browserRuntime.close().catch(() => {});
            } else {
                if (context) await context.close().catch(() => {});
                if (browser) await browser.close().catch(() => {});
            }
            await this._writeJson(path.join(artifactsDir, 'summary.json'), summary);
        }
    }

    async _ensureNextRequestAccountAccess(page, portalUrl, {
        caseData,
        requester,
        existingAccount = null,
        credentials,
        authOnly = false,
        forceAccountSetup = false,
    } = {}) {
        const requestFormUrl = buildPortalActionUrl(portalUrl, '/requests/new');
        const loginUrl = buildPortalActionUrl(portalUrl, '/users/sign_in');
        const effectiveCredentials = credentials || buildPortalCredentialProfile(requester, existingAccount);

        if (!existingAccount) {
            await this._goto(page, requestFormUrl, { providerHint: 'nextrequest' });
            const publicPageKind = await this._detectPageKind(page);
            if (publicPageKind === 'request_form') {
                const marker = await this._savePortalAccountMarker({
                    portalUrl,
                    requester,
                    credentials: effectiveCredentials,
                    accountStatus: 'no_account_needed',
                    userId: caseData?.user_id || null,
                    source: 'playwright_nextrequest_public_form',
                    existingAccount,
                });
                return {
                    success: true,
                    status: authOnly ? 'auth_not_required' : 'request_form_public',
                    accountEmail: effectiveCredentials.email,
                    portalAccount: marker,
                    step: {
                        step: 'prepare_nextrequest_account',
                        outcome: 'public_request_form',
                        url: page.url(),
                    },
                    extracted_data: {
                        provider: 'nextrequest',
                        auth_method: 'public_request_form',
                        request_form_url: page.url(),
                    },
                };
            }
        }

        const loginAttempt = await this._loginToNextRequest(page, portalUrl, effectiveCredentials);
        if (loginAttempt.success) {
            const resolvedAccount = await this._saveResolvedPortalAccount({
                portalUrl,
                requester,
                credentials: effectiveCredentials,
                existingAccount,
                userId: caseData?.user_id || null,
                source: 'playwright_nextrequest_login',
                linkKind: null,
            });
            return {
                success: true,
                status: 'auth_ready',
                accountEmail: effectiveCredentials.email,
                portalAccount: resolvedAccount,
                step: {
                    step: 'prepare_nextrequest_account',
                    outcome: 'logged_in',
                    url: page.url(),
                },
                extracted_data: {
                    provider: 'nextrequest',
                    auth_method: 'stored_credentials',
                    login_url: loginUrl,
                },
            };
        }

        const magicLink = await this._requestNextRequestMagicLink(page, portalUrl, effectiveCredentials.email);
        if (!magicLink.success || !magicLink.link) {
            return {
                success: false,
                accountEmail: effectiveCredentials.email,
                blocker: {
                    status: 'nextrequest_account_email_not_received',
                    reason: magicLink.reason || loginAttempt.reason || 'NextRequest account setup email was not received',
                },
                extracted_data: {
                    provider: 'nextrequest',
                    auth_method: 'email_recovery_failed',
                    login_error: loginAttempt.reason || null,
                },
            };
        }

        const openedLink = await this._openNextRequestMagicLink(page, magicLink.link, effectiveCredentials.password);
        if (!openedLink.success) {
            return {
                success: false,
                accountEmail: effectiveCredentials.email,
                blocker: {
                    status: 'nextrequest_account_link_failed',
                    reason: openedLink.reason || 'NextRequest account link could not be completed',
                },
                extracted_data: {
                    provider: 'nextrequest',
                    auth_method: 'email_recovery_failed',
                    link_kind: magicLink.linkKind,
                },
            };
        }

        const verificationLogin = await this._loginToNextRequest(page, portalUrl, effectiveCredentials);
        if (!verificationLogin.success) {
            const blockerStatus = isBrowserbaseAuthInterventionState(verificationLogin?.state)
                ? 'auth_intervention_required'
                : 'nextrequest_auth_failed';
            return {
                success: false,
                accountEmail: effectiveCredentials.email,
                blocker: {
                    status: blockerStatus,
                    reason: verificationLogin.reason || 'NextRequest login failed after account recovery',
                },
                extracted_data: {
                    provider: 'nextrequest',
                    auth_method: 'email_recovery',
                    link_kind: magicLink.linkKind,
                    login_error: verificationLogin.reason || null,
                },
            };
        }

        const resolvedAccount = await this._saveResolvedPortalAccount({
            portalUrl,
            requester,
            credentials: effectiveCredentials,
            existingAccount,
            userId: caseData?.user_id || null,
            source: 'playwright_nextrequest_email_recovery',
            linkKind: magicLink.linkKind,
        });

        return {
            success: true,
            status: existingAccount ? 'account_recovered' : 'account_created',
            accountEmail: effectiveCredentials.email,
            portalAccount: resolvedAccount,
            step: {
                step: 'prepare_nextrequest_account',
                outcome: existingAccount ? 'recovered_via_email' : 'created_via_email',
                url: page.url(),
            },
            extracted_data: {
                provider: 'nextrequest',
                auth_method: 'email_recovery',
                link_kind: magicLink.linkKind,
                inbox: magicLink.inboxAddress || null,
            },
        };
    }

    async _loginToNextRequest(page, portalUrl, credentials) {
        const loginUrl = buildPortalActionUrl(portalUrl, '/users/sign_in');
        await this._goto(page, loginUrl, { providerHint: 'nextrequest' });

        const preLoginState = await this._detectNextRequestAuthState(page);
        if (preLoginState.status === 'totp_required') {
            const recovered = await this._attemptPortalEmailCodeVerification(page, portalUrl, credentials.email, {
                provider: 'nextrequest',
                fromEmailHints: ['civicplus.com', 'nextrequest.com'],
            });
            if (recovered.success) {
                const recoveredState = await this._detectNextRequestAuthState(page);
                return {
                    success: recoveredState.status === 'authenticated',
                    reason: recoveredState.message,
                    state: recoveredState,
                };
            }
            return {
                success: false,
                reason: recovered.reason || preLoginState.message || 'NextRequest requires a manual verification code',
                state: {
                    ...preLoginState,
                    status: 'auth_intervention_required',
                    source_status: 'totp_required',
                    message: recovered.reason || preLoginState.message || 'NextRequest requires a manual verification code',
                },
            };
        }
        if (['external_auth_required', 'verification_required'].includes(preLoginState.status)) {
            return {
                success: false,
                reason: preLoginState.message || 'NextRequest requires manual authentication',
                state: {
                    ...preLoginState,
                    status: 'auth_intervention_required',
                    source_status: preLoginState.status,
                    message: preLoginState.message || 'NextRequest requires manual authentication',
                },
            };
        }
        if (preLoginState.status !== 'sign_in_required') {
            return {
                success: preLoginState.status === 'authenticated',
                reason: preLoginState.message,
                state: preLoginState,
            };
        }

        const emailField = page.getByLabel(/email/i).first();
        const passwordField = page.getByLabel(/password/i).first();
        const emailCount = await emailField.count().catch(() => 0);
        const passwordCount = await passwordField.count().catch(() => 0);
        const emailVisible = emailCount > 0 ? await emailField.isVisible().catch(() => false) : false;
        const passwordVisible = passwordCount > 0 ? await passwordField.isVisible().catch(() => false) : false;

        if (!emailCount || !passwordCount || !emailVisible || !passwordVisible) {
            const state = await this._detectNextRequestAuthState(page);
            return {
                success: state.status === 'authenticated',
                reason: state.message,
                state,
            };
        }

        await emailField.fill(credentials.email);
        await passwordField.fill(credentials.password);

        const signInButton = page.getByRole('button', { name: /sign in/i }).first();
        if (await signInButton.count().catch(() => 0)) {
            await Promise.allSettled([
                page.waitForLoadState('domcontentloaded'),
                signInButton.click(),
            ]);
        } else {
            await passwordField.press('Enter').catch(() => {});
        }
        await sleep(1500);

        let state = await this._detectNextRequestAuthState(page);
        if (state.status === 'totp_required') {
            const recovered = await this._attemptPortalEmailCodeVerification(page, portalUrl, credentials.email, {
                provider: 'nextrequest',
                fromEmailHints: ['civicplus.com', 'nextrequest.com'],
            });
            if (recovered.success) {
                state = await this._detectNextRequestAuthState(page);
            } else {
                state = {
                    ...state,
                    status: 'auth_intervention_required',
                    source_status: 'totp_required',
                    message: recovered.reason || state.message || 'NextRequest requires a manual verification code',
                };
            }
        }
        return {
            success: state.status === 'authenticated',
            reason: state.message,
            state,
        };
    }

    async _detectNextRequestAuthState(page) {
        const currentUrl = page.url();
        const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));
        const pageKind = await this._detectPageKind(page);

        if (/cpauthentication\.civicplus\.com/i.test(currentUrl)) {
            if (
                bodyText.includes('checking your browser') ||
                bodyText.includes('verify you are human') ||
                bodyText.includes('performing security verification')
            ) {
                return { status: 'blocked_cloudflare', message: 'NextRequest redirected into CivicPlus verification' };
            }
            if (
                bodyText.includes('verification code') ||
                bodyText.includes('authenticator') ||
                bodyText.includes('two factor') ||
                bodyText.includes('two-factor') ||
                bodyText.includes('one-time password') ||
                bodyText.includes('totp')
            ) {
                return { status: 'totp_required', message: 'NextRequest requires a CivicPlus verification code' };
            }
            return { status: 'external_auth_required', message: 'NextRequest redirected into CivicPlus authentication' };
        }

        if (
            !/\/users\/sign_in/i.test(currentUrl) &&
            (
                pageKind === 'request_form' ||
                /\/requests(\/new)?/i.test(currentUrl) ||
                bodyText.includes('sign out') ||
                bodyText.includes('my requests') ||
                bodyText.includes('account settings')
            )
        ) {
            return { status: 'authenticated', message: null };
        }

        if (bodyText.includes('temporarily locked') || bodyText.includes('account was locked') || bodyText.includes('locked out')) {
            return { status: 'locked', message: 'NextRequest account is locked' };
        }
        if (
            bodyText.includes('invalid email or password') ||
            bodyText.includes('incorrect email or password') ||
            bodyText.includes('invalid login')
        ) {
            return { status: 'invalid_credentials', message: 'Invalid email or password' };
        }
        if (
            bodyText.includes('finish setting up your account') ||
            bodyText.includes('check your email') ||
            bodyText.includes('confirm your account')
        ) {
            return { status: 'verification_required', message: 'NextRequest account requires email confirmation or setup' };
        }

        return { status: 'sign_in_required', message: 'NextRequest still requires sign-in' };
    }

    async _requestNextRequestMagicLink(page, portalUrl, email) {
        const helpUrl = buildPortalActionUrl(portalUrl, '/sign_in_help');
        await this._goto(page, helpUrl, { providerHint: 'nextrequest' });

        const emailField = page.getByLabel(/email/i).first();
        const submitButton = page.getByRole('button', { name: /submit/i }).first();

        if (!await emailField.count().catch(() => 0) || !await submitButton.count().catch(() => 0)) {
            return {
                success: false,
                reason: 'NextRequest sign-in help form was not available',
            };
        }

        await emailField.fill(email);
        await Promise.allSettled([
            page.waitForLoadState('domcontentloaded'),
            submitButton.click(),
        ]);
        await sleep(1000);

        const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));
        if (bodyText.includes("cant find your account with that email")) {
            return {
                success: false,
                reason: 'NextRequest does not know this email on the portal yet',
            };
        }

        const resetPasswordButton = page.getByRole('button', { name: /reset password/i }).first();
        if (await resetPasswordButton.count().catch(() => 0)) {
            await Promise.allSettled([
                page.waitForLoadState('domcontentloaded'),
                resetPasswordButton.click(),
            ]);
            await sleep(1000);
        }

        return this._waitForNextRequestMagicLink(portalUrl, email);
    }

    async _waitForNextRequestMagicLink(portalUrl, email) {
        const timeoutMs = parseInt(process.env.PORTAL_VERIFICATION_TIMEOUT_MS || '180000', 10);
        const inboxCandidates = Array.from(
            new Set([
                email,
                process.env.REQUESTS_INBOX,
            ].filter(Boolean))
        );
        let lastError = null;

        for (const inboxAddress of inboxCandidates) {
            const helper = new EmailVerificationHelper({ inboxAddress, pollIntervalMs: 5000 });
            try {
                const link = await helper.waitForCode({
                    pattern: process.env.PORTAL_VERIFICATION_REGEX || NEXTREQUEST_MAGIC_LINK_PATTERN,
                    timeoutMs,
                    fromEmail: 'nextrequest.com',
                });
                return {
                    success: true,
                    link: String(link || '').trim(),
                    linkKind: inferNextRequestLinkKind(link),
                    inboxAddress,
                };
            } catch (error) {
                lastError = error;
            }
        }

        return {
            success: false,
            reason: lastError?.message || `Timed out waiting for a NextRequest link for ${email}`,
        };
    }

    async _openNextRequestMagicLink(page, link, password) {
        if (!link) {
            return {
                success: false,
                reason: 'No NextRequest magic link available',
            };
        }

        await this._goto(page, link, { providerHint: 'nextrequest' });
        await this._submitNextRequestPasswordFormIfPresent(page, password);

        const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));
        if (
            bodyText.includes('token is invalid') ||
            bodyText.includes('token has expired') ||
            bodyText.includes('link is invalid') ||
            bodyText.includes('link has expired')
        ) {
            return {
                success: false,
                reason: 'NextRequest magic link is invalid or expired',
            };
        }

        return {
            success: true,
            linkKind: inferNextRequestLinkKind(link),
        };
    }

    async _submitNextRequestPasswordFormIfPresent(page, password) {
        const passwordFields = page.locator('input[type="password"]:visible');
        const count = await passwordFields.count().catch(() => 0);
        if (count === 0) return false;

        for (let index = 0; index < count; index += 1) {
            await passwordFields.nth(index).fill(password).catch(() => {});
        }

        const submitButton = page
            .getByRole('button', { name: /save|submit|continue|change|set|reset|update/i })
            .first();
        if (await submitButton.count().catch(() => 0)) {
            await Promise.allSettled([
                page.waitForLoadState('domcontentloaded'),
                submitButton.click(),
            ]);
        } else {
            await passwordFields.first().press('Enter').catch(() => {});
        }
        await sleep(1500);
        return true;
    }

    async _attemptPortalEmailCodeVerification(page, portalUrl, email, { provider = 'generic', fromEmailHints = [] } = {}) {
        const codeField = await this._findVerificationCodeField(page);
        if (!codeField) {
            return { success: false, reason: 'verification_code_field_not_found' };
        }

        const codeResult = await this._waitForPortalVerificationCode(portalUrl, email, {
            fromEmailHints,
            pattern: process.env.PORTAL_VERIFICATION_REGEX || DEFAULT_PORTAL_VERIFICATION_CODE_PATTERN,
        });
        if (!codeResult.success || !codeResult.code) {
            return { success: false, reason: codeResult.reason || 'verification_code_not_received' };
        }

        try {
            await codeField.fill(String(codeResult.code));
        } catch (error) {
            return { success: false, reason: truncate(error?.message || String(error), 160) };
        }

        const verifyButton = page
            .getByRole('button', { name: /verify|continue|submit|sign in|next/i })
            .first();
        if (await verifyButton.count().catch(() => 0)) {
            await Promise.allSettled([
                page.waitForLoadState('domcontentloaded').catch(() => {}),
                verifyButton.click(),
            ]);
        } else {
            await codeField.press('Enter').catch(() => {});
        }
        await sleep(1500);

        return {
            success: true,
            codeInbox: codeResult.inboxAddress || null,
            codeSender: codeResult.fromEmail || null,
            provider,
        };
    }

    async _findVerificationCodeField(page) {
        const prioritizedLocators = [
            page.getByLabel(/verification code|security code|one[- ]time password|passcode|authentication code/i).first(),
            page.locator('input[name*=code i], input[id*=code i], input[autocomplete="one-time-code"]').first(),
        ];

        for (const locator of prioritizedLocators) {
            const count = await locator.count().catch(() => 0);
            if (!count) continue;
            const visible = await locator.isVisible().catch(() => false);
            if (visible) return locator;
        }

        return null;
    }

    async _waitForPortalVerificationCode(portalUrl, email, { fromEmailHints = [], pattern = DEFAULT_PORTAL_VERIFICATION_CODE_PATTERN } = {}) {
        const timeoutMs = parseInt(process.env.PORTAL_VERIFICATION_TIMEOUT_MS || '180000', 10);
        const inboxCandidates = Array.from(new Set([
            email,
            process.env.REQUESTS_INBOX,
        ].filter(Boolean)));

        let defaultFromEmail = null;
        try {
            const hostname = new URL(portalUrl).hostname.toLowerCase();
            defaultFromEmail = hostname.split('.').slice(-2).join('.');
        } catch (error) {}

        const senderHints = Array.from(new Set([
            ...fromEmailHints,
            defaultFromEmail,
            null,
        ]));

        let lastError = null;
        for (const inboxAddress of inboxCandidates) {
            const helper = new EmailVerificationHelper({ inboxAddress, pollIntervalMs: 5000 });
            for (const fromEmail of senderHints) {
                try {
                    const code = await helper.waitForCode({
                        pattern,
                        timeoutMs,
                        fromEmail,
                    });
                    return {
                        success: true,
                        code: String(code || '').trim(),
                        inboxAddress,
                        fromEmail: fromEmail || null,
                    };
                } catch (error) {
                    lastError = error;
                }
            }
        }

        return {
            success: false,
            reason: lastError?.message || `Timed out waiting for a portal verification code for ${email}`,
        };
    }

    async _savePortalAccountMarker({
        portalUrl,
        requester,
        credentials,
        accountStatus,
        userId,
        source,
        existingAccount = null,
    }) {
        if (existingAccount) {
            if (existingAccount.account_status !== accountStatus) {
                await database.updatePortalAccountStatus(existingAccount.id, accountStatus).catch(() => {});
            }
            return existingAccount;
        }

        const saved = await database.createPortalAccount({
            portal_url: portalUrl,
            portal_type: 'nextrequest',
            email: credentials.email,
            password: credentials.password,
            first_name: requester.firstName,
            last_name: requester.lastName,
            account_status: accountStatus,
            user_id: userId || null,
            additional_info: {
                created_by: source,
            },
        }).catch(() => null);

        if (saved) {
            saved.password = credentials.password;
        }

        return saved;
    }

    async _saveResolvedPortalAccount({
        portalUrl,
        requester,
        credentials,
        existingAccount = null,
        userId = null,
        source,
        linkKind = null,
    }) {
        if (
            existingAccount &&
            existingAccount.email === credentials.email &&
            existingAccount.password === credentials.password
        ) {
            await database.updatePortalAccountStatus(existingAccount.id, 'active').catch(() => {});
            await database.updatePortalAccountLastUsed(existingAccount.id).catch(() => {});
            existingAccount.account_status = 'active';
            return existingAccount;
        }

        const saved = await database.createPortalAccount({
            portal_url: portalUrl,
            portal_type: 'nextrequest',
            email: credentials.email,
            password: credentials.password,
            first_name: requester.firstName,
            last_name: requester.lastName,
            account_status: 'active',
            user_id: userId || null,
            additional_info: {
                created_by: source,
                recovered_via: linkKind,
                previous_account_id: existingAccount?.id || null,
            },
        }).catch(() => null);

        if (saved) {
            saved.password = credentials.password;
            await database.updatePortalAccountLastUsed(saved.id).catch(() => {});
            return saved;
        }

        if (existingAccount) {
            await database.updatePortalAccountStatus(existingAccount.id, 'active').catch(() => {});
            await database.updatePortalAccountLastUsed(existingAccount.id).catch(() => {});
            existingAccount.account_status = 'active';
            existingAccount.password = credentials.password;
            return existingAccount;
        }

        return {
            email: credentials.email,
            password: credentials.password,
            account_status: 'active',
        };
    }

    async _goto(page, url, options = {}) {
        const normalizedHint = normalizeProviderName(options.providerHint, url);
        const waitUntil = normalizedHint === 'govqa' && options.initialLoad ? 'commit' : 'domcontentloaded';
        const timeoutMs = normalizedHint === 'govqa' && options.initialLoad
            ? Math.max(this.timeoutMs, 60_000)
            : this.timeoutMs;

        try {
            await page.goto(url, { waitUntil, timeout: timeoutMs });
            await page.waitForLoadState('domcontentloaded', {
                timeout: waitUntil === 'commit' ? 8_000 : timeoutMs,
            }).catch(() => {});
        } catch (error) {
            const looksLikeTimeout = /page\.goto: Timeout|Timeout .*exceeded/i.test(String(error?.message || ''));
            const currentUrl = page.url();
            if (!looksLikeTimeout || !currentUrl || currentUrl === 'about:blank') {
                throw error;
            }
        }
        await page.waitForTimeout(1500);
    }

    async _detectProvider(page, portalUrl, providerHint) {
        const normalizedHint = normalizeProviderName(providerHint, portalUrl);
        if (normalizedHint !== 'generic') return normalizedHint;

        const title = normalizeText(await page.title().catch(() => ''));
        const body = normalizeText(await page.locator('body').innerText().catch(() => ''));
        const haystack = `${title} ${body}`;

        if (haystack.includes('nextrequest')) return 'nextrequest';
        if (haystack.includes('justfoia')) return 'justfoia';
        if (haystack.includes('govqa') || haystack.includes('open records center')) return 'govqa';
        if (haystack.includes('form center')) return 'formcenter';
        return 'generic';
    }

    async _detectBlockingState(page) {
        const title = normalizeText(await page.title().catch(() => ''));
        const body = normalizeText(await page.locator('body').innerText().catch(() => ''));
        const combined = `${title} ${body}`;

        if (combined.includes('performing security verification') || combined.includes('verify you are human') || combined.includes('checking your browser')) {
            return {
                status: 'blocked_cloudflare',
                reason: 'Portal presented a Cloudflare verification challenge',
            };
        }

        if (combined.includes('unable to establish a secure connection') || combined.includes('access restricted')) {
            return {
                status: 'blocked_access_restricted',
                reason: 'Portal rejected the current browser session before form access',
            };
        }

        return null;
    }

    async _detectCaptchaRequirement(page, visibleFields = []) {
        const matchingField = Array.isArray(visibleFields)
            ? visibleFields.find((field) => isCaptchaLikeField(field))
            : null;

        if (matchingField) {
            return {
                status: 'captcha_detected',
                reason: 'Portal requires CAPTCHA verification before submission',
                field: matchingField.label || matchingField.name || matchingField.id || matchingField.type || 'captcha',
            };
        }

        const body = normalizeText(await page.locator('body').innerText().catch(() => ''));
        if (/\bcaptcha\b|\benter the characters\b|\benter the code shown\b|\btype the characters\b/.test(body)) {
            return {
                status: 'captcha_detected',
                reason: 'Portal requires CAPTCHA verification before submission',
            };
        }

        return null;
    }

    async _navigateToWorkSurface(page, provider, caseData, portalUrl) {
        switch (provider) {
        case 'govqa':
            return this._navigateGovQa(page, caseData);
        case 'nextrequest':
            return this._navigateNextRequest(page, portalUrl);
        case 'justfoia':
            return this._navigateJustFoia(page, portalUrl);
        case 'formcenter':
            return { step: { step: 'navigate_formcenter', url: page.url() } };
        default:
            return { step: { step: 'navigate_generic', url: page.url() } };
        }
    }

    async _navigateNextRequest(page, portalUrl) {
        const existingBlock = await this._detectBlockingState(page);
        if (existingBlock) return { blocker: existingBlock };

        if (!/\/requests\/new/i.test(page.url())) {
            const targetUrl = new URL('/requests/new', portalUrl).toString();
            await this._goto(page, targetUrl);
        }

        return {
            step: {
                step: 'navigate_nextrequest',
                url: page.url(),
            },
        };
    }

    async _navigateJustFoia(page, portalUrl) {
        const existingBlock = await this._detectBlockingState(page);
        if (existingBlock) return { blocker: existingBlock };

        if (!/\/publicportal\/home\/newrequest/i.test(page.url())) {
            const targetUrl = new URL('/publicportal/home/newrequest', portalUrl).toString();
            await this._goto(page, targetUrl);
        }

        const links = await page.locator('a').evaluateAll((elements) => {
            return elements.map((element, index) => ({
                index,
                text: (element.textContent || '').trim(),
                href: element.href || element.getAttribute('href') || '',
            }));
        }).catch(() => []);

        const best = links
            .filter((link) => /\/Forms\/Launch\//i.test(link.href))
            .map((link) => ({
                ...link,
                score: scoreJustFoiaLaunchLink(link.text),
            }))
            .sort((left, right) => right.score - left.score)[0];

        if (best && best.score > 0) {
            await this._goto(page, best.href);
        }

        return {
            step: {
                step: 'navigate_justfoia',
                url: page.url(),
                matchedLink: best?.text || null,
            },
        };
    }

    async _navigateGovQa(page, caseData) {
        if (/requestlogin\.aspx|customerhome\.aspx/i.test(page.url())) {
            return {
                step: {
                    step: 'navigate_govqa_existing',
                    url: page.url(),
                },
            };
        }

        const submitRequest = page.getByRole('link', { name: /submit a request/i }).first();
        if (await submitRequest.count()) {
            await Promise.allSettled([
                page.waitForLoadState('domcontentloaded'),
                submitRequest.click(),
            ]);
            await page.waitForTimeout(1200);
        }

        const tileOptions = await page.locator('div.live-tile[role="link"]').evaluateAll((elements) => {
            return elements.map((element, index) => ({
                index,
                kind: 'tile',
                text: (element.textContent || '').trim(),
                href: element.getAttribute('data-link') || '',
            }));
        }).catch(() => []);

        const linkOptions = await page.locator('a').evaluateAll((elements) => {
            return elements.map((element, index) => ({
                index,
                kind: 'link',
                text: (element.textContent || '').trim(),
                href: element.getAttribute('href') || '',
            }));
        }).catch(() => []);

        const best = [...tileOptions, ...linkOptions]
            .map((option) => ({
                ...option,
                score: scoreGovQaRequestLink(caseData?.agency_name, option.text),
            }))
            .sort((left, right) => right.score - left.score)[0];

        if (best && best.score > 0) {
            const locator = best.kind === 'tile'
                ? page.locator('div.live-tile[role="link"]').nth(best.index)
                : page.locator('a').nth(best.index);
            await Promise.allSettled([
                page.waitForLoadState('domcontentloaded'),
                locator.click(),
            ]);
            await page.waitForTimeout(1200);
        }

        return {
            step: {
                step: 'navigate_govqa',
                url: page.url(),
                matchedLink: best?.text || null,
            },
        };
    }

    async _detectPageKind(page) {
        const currentUrl = normalizeText(page.url());
        const emailLikeCount = await page.locator([
            'input[type=\"email\"]',
            'input[name*=\"email\" i]',
            'input[id*=\"email\" i]',
        ].join(', ')).count().catch(() => 0);
        const passwordCount = await page.locator('input[type="password"]').count().catch(() => 0);
        const visibleFields = await page.locator('input, textarea, select').evaluateAll((elements) => {
            const isVisible = (element) => {
                const style = window.getComputedStyle(element);
                return Boolean(style) && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
            };
            return elements.filter(isVisible).length;
        }).catch(() => 0);
        const buttonText = normalizeText(
            await page.locator('body').innerText().catch(() => '')
        );
        const looksLikeAuthPage =
            /requestlogin\.aspx|login|sign[\s-]?in/.test(currentUrl) ||
            buttonText.includes('login') ||
            buttonText.includes('log in') ||
            buttonText.includes('sign in') ||
            buttonText.includes('create account');

        if (passwordCount > 0) return 'auth_page';
        if (looksLikeAuthPage && visibleFields > 0 && visibleFields < 5 && emailLikeCount > 0) return 'auth_page';
        if (visibleFields >= 5) return 'request_form';
        if (buttonText.includes('make request') || buttonText.includes('new request') || buttonText.includes('submit a request')) {
            return 'landing_page';
        }
        return 'unknown';
    }

    async _analyzeVisibleFields(page) {
        const fields = await page.evaluate(() => {
            const isVisible = (element) => {
                const style = window.getComputedStyle(element);
                return Boolean(style) && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
            };

            const labelFor = (element) => {
                const directAria = element.getAttribute('aria-label');
                if (directAria) return directAria.trim();

                const labelledBy = element.getAttribute('aria-labelledby');
                if (labelledBy) {
                    const parts = labelledBy
                        .split(/\s+/)
                        .map((id) => document.getElementById(id))
                        .filter(Boolean)
                        .map((node) => (node.textContent || '').trim())
                        .filter(Boolean);
                    if (parts.length > 0) return parts.join(' ');
                }

                if (element.id) {
                    const label = document.querySelector(`label[for="${element.id}"]`);
                    if (label?.textContent) return label.textContent.trim();
                }

                const wrapped = element.closest('label');
                if (wrapped?.textContent) return wrapped.textContent.trim();

                let sibling = element.previousElementSibling;
                while (sibling) {
                    const text = (sibling.textContent || '').trim();
                    if (text) return text;
                    sibling = sibling.previousElementSibling;
                }

                const parentText = (element.parentElement?.textContent || '').trim();
                return parentText.length <= 140 ? parentText : '';
            };

            return Array.from(document.querySelectorAll('input, textarea, select')).map((element, index) => {
                const tag = element.tagName.toLowerCase();
                const type = (element.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
                const options = tag === 'select'
                    ? Array.from(element.options).map((option) => ({
                        value: option.value,
                        text: (option.textContent || '').trim(),
                    }))
                    : [];

                return {
                    index,
                    tag,
                    type,
                    id: element.id || '',
                    name: element.getAttribute('name') || '',
                    label: labelFor(element),
                    placeholder: element.getAttribute('placeholder') || '',
                    ariaLabel: element.getAttribute('aria-label') || '',
                    required: element.required || element.getAttribute('aria-required') === 'true',
                    disabled: element.disabled,
                    readOnly: element.readOnly,
                    visible: isVisible(element),
                    options,
                };
            });
        });

        return {
            fields,
            visibleFields: fields.filter((field) => {
                return field.visible && !field.disabled && !field.readOnly && !['hidden', 'submit', 'button', 'image', 'file'].includes(field.type);
            }),
        };
    }

    async _fillVisibleFields(page, fields, context) {
        const filled = [];
        const skipped = [];

        for (const field of fields) {
            const value = mapFieldValue(field, context);
            if (value === null || value === undefined || value === '') {
                skipped.push({ field: field.label || field.name || field.id || field.type, reason: 'no_mapped_value' });
                continue;
            }

            const locator = this._locatorForField(page, field);
            if (!locator) {
                skipped.push({ field: field.label || field.name || field.id || field.type, reason: 'no_locator' });
                continue;
            }

            try {
                if (field.tag === 'select') {
                    await locator.selectOption({ label: String(value) }).catch(async () => {
                        await locator.selectOption(String(value));
                    });
                } else if (field.type === 'checkbox') {
                    if (value) await locator.check();
                } else {
                    await locator.fill(String(value));
                }

                filled.push({
                    field: field.label || field.name || field.id || field.type,
                    value: truncate(value),
                });
            } catch (error) {
                skipped.push({
                    field: field.label || field.name || field.id || field.type,
                    reason: truncate(error?.message || String(error), 120),
                });
            }
        }

        return { filled, skipped };
    }

    async _submitFilledRequest(page, provider) {
        const submitControl = await this._findSubmitControl(page);
        if (!submitControl) {
            return {
                attempted: false,
                confirmed: false,
                fallbackSafe: true,
                status: 'submit_button_not_found',
                blocker: {
                    status: 'submit_button_not_found',
                    reason: 'No visible submit control was detected on the request form',
                },
            };
        }

        const beforeUrl = page.url();
        const beforeBody = normalizeText(await page.locator('body').innerText().catch(() => ''));

        await Promise.allSettled([
            page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {}),
            submitControl.click(),
        ]);
        await page.waitForTimeout(2500).catch(() => {});

        const validationErrors = await this._collectValidationErrors(page);
        const afterUrl = page.url();
        const afterBody = normalizeText(await page.locator('body').innerText().catch(() => ''));
        const confirmation = this._detectSubmissionConfirmation({
            provider,
            beforeUrl,
            afterUrl,
            beforeBody,
            afterBody,
        });

        if (confirmation.confirmed) {
            return {
                attempted: true,
                confirmed: true,
                fallbackSafe: false,
                status: 'submitted_confirmation_detected',
                confirmationNumber: confirmation.confirmationNumber || null,
                step: {
                    step: 'submit_request',
                    outcome: 'confirmed',
                    url: afterUrl,
                    confirmationNumber: confirmation.confirmationNumber || null,
                },
            };
        }

        if (validationErrors.length > 0) {
            return {
                attempted: true,
                confirmed: false,
                fallbackSafe: true,
                status: 'submission_validation_failed',
                blocker: {
                    status: 'submission_validation_failed',
                    reason: `Portal validation blocked submission: ${truncate(validationErrors[0], 160)}`,
                },
                step: {
                    step: 'submit_request',
                    outcome: 'validation_failed',
                    url: afterUrl,
                },
            };
        }

        return {
            attempted: true,
            confirmed: false,
            fallbackSafe: false,
            status: 'submission_unconfirmed',
            blocker: {
                status: 'submission_unconfirmed',
                reason: 'Playwright clicked the submit control but could not confirm whether the request was accepted',
            },
            step: {
                step: 'submit_request',
                outcome: 'unconfirmed',
                url: afterUrl,
            },
        };
    }

    async _findSubmitControl(page) {
        const controls = await page.locator(SUBMIT_CONTROL_SELECTOR).evaluateAll((elements) => {
            const isVisible = (element) => {
                const style = window.getComputedStyle(element);
                return Boolean(style) && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
            };

            return elements.map((element, index) => {
                const text = (
                    element.textContent ||
                    element.getAttribute('value') ||
                    element.getAttribute('aria-label') ||
                    ''
                ).trim();
                return {
                    index,
                    tag: String(element.tagName || '').toLowerCase(),
                    text,
                    id: element.id || '',
                    name: element.getAttribute('name') || '',
                    ariaLabel: element.getAttribute('aria-label') || '',
                    className: typeof element.className === 'string' ? element.className : '',
                    visible: isVisible(element),
                    disabled: element.disabled === true,
                };
            });
        }).catch(() => []);

        const scored = scoreSubmitControlCandidates(controls);

        const best = scored[0];
        if (!best || best.score < 0) return null;
        return page.locator(SUBMIT_CONTROL_SELECTOR).nth(best.index);
    }

    async _collectValidationErrors(page) {
        const messages = await page.locator(
            '[role="alert"], .error, .field-validation-error, .validation-summary-errors, .error-message'
        ).evaluateAll((elements) => {
            return elements
                .map((element) => (element.textContent || '').trim())
                .filter(Boolean);
        }).catch(() => []);

        return Array.from(new Set(messages));
    }

    _detectSubmissionConfirmation({ provider, beforeUrl, afterUrl, beforeBody, afterBody }) {
        const confirmationPatterns = [
            /(confirmation|request|reference)\s*(number|#|no\.?)?\s*[:#-]?\s*([a-z0-9-]{4,})/i,
            /\btracking\s*(number|#|no\.?)?\s*[:#-]?\s*([a-z0-9-]{4,})/i,
        ];
        const successSignals = [
            'thank you',
            'request has been submitted',
            'request submitted',
            'request received',
            'we have received your request',
            'submission complete',
            'submission received',
        ];

        const urlChanged = String(afterUrl || '') !== String(beforeUrl || '');
        const successText = successSignals.some((signal) => afterBody.includes(signal));
        const confirmationMatch = confirmationPatterns
            .map((pattern) => afterBody.match(pattern))
            .find(Boolean);
        const confirmationNumber = confirmationMatch
            ? confirmationMatch[3] || confirmationMatch[2] || null
            : null;

        if (provider === 'formcenter' && afterBody.includes('thank you')) {
            return { confirmed: true, confirmationNumber };
        }

        if (successText || confirmationNumber || (urlChanged && !afterBody.includes('required field'))) {
            return { confirmed: true, confirmationNumber };
        }

        return { confirmed: false, confirmationNumber: null };
    }

    _locatorForField(page, field) {
        if (field.id) {
            return page.locator(attrSelector('id', field.id)).first();
        }
        if (field.name) {
            return page.locator(attrSelector('name', field.name)).first();
        }
        if (field.label) {
            const escaped = field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return page.getByLabel(new RegExp(escaped, 'i')).first();
        }
        return null;
    }

    _resolveAuthInterventionLiveUrl(summary) {
        return summary.browser_debugger_url
            || summary.browser_debugger_fullscreen_url
            || summary.browser_session_url
            || null;
    }

    async _syncPortalAccountBrowserbaseContext(portalAccount, summary, {
        contextStatus = undefined,
        authenticated = false,
        metadata = {},
    } = {}) {
        if (!portalAccount?.id || !summary?.auth_context_id) return portalAccount;

        const existingMetadata = portalAccount.browserbase_auth_metadata && typeof portalAccount.browserbase_auth_metadata === 'object'
            ? portalAccount.browserbase_auth_metadata
            : {};
        const update = {
            contextId: summary.auth_context_id,
            contextStatus,
            lastAuthAt: new Date(),
            metadata: {
                ...existingMetadata,
                ...metadata,
                last_browser_session_id: summary.browser_session_id || null,
                last_browser_session_url: summary.browser_session_url || null,
                last_live_view_url: this._resolveAuthInterventionLiveUrl(summary),
                last_portal_status: summary.status || null,
            },
        };

        if (authenticated) {
            update.authenticatedAt = new Date();
        }

        await database.updatePortalAccountBrowserbaseContext(portalAccount.id, update).catch(() => null);
        portalAccount.browserbase_context_id = summary.auth_context_id;
        if (contextStatus !== undefined) {
            portalAccount.browserbase_context_status = contextStatus;
        }
        portalAccount.browserbase_auth_metadata = update.metadata;
        return portalAccount;
    }

    async _markAuthInterventionRequired(summary, page, portalAccount, reason, sourceStatus = 'auth_intervention_required') {
        const requestedAt = new Date().toISOString();
        summary.status = 'auth_intervention_required';
        summary.success = false;
        summary.error = reason;
        summary.fallback_safe = false;
        summary.preserve_browser_session = true;
        summary.auth_intervention_status = 'requested';
        summary.auth_intervention_reason = reason;
        summary.auth_intervention_requested_at = requestedAt;
        summary.final_url = page?.url?.() || summary.final_url;

        const blocker = {
            status: 'auth_intervention_required',
            reason,
            source_status: sourceStatus,
            live_view_url: this._resolveAuthInterventionLiveUrl(summary),
        };
        summary.blockers.push(blocker);
        summary.extracted_data = {
            ...(summary.extracted_data && typeof summary.extracted_data === 'object' ? summary.extracted_data : {}),
            auth_intervention: {
                requested_at: requestedAt,
                reason,
                live_view_url: this._resolveAuthInterventionLiveUrl(summary),
                browser_session_id: summary.browser_session_id || null,
                auth_context_id: summary.auth_context_id || null,
            },
        };

        await this._syncPortalAccountBrowserbaseContext(portalAccount, summary, {
            contextStatus: 'intervention_required',
            authenticated: false,
            metadata: {
                intervention_requested_at: requestedAt,
                intervention_reason: reason,
                source_status: sourceStatus,
            },
        }).catch(() => null);

        return blocker;
    }

    async _startTrackedRun(caseData, summary, shouldTrackInAutobot) {
        if (!shouldTrackInAutobot || !summary.caseId) return null;

        const submission = await database.createPortalSubmission({
            caseId: summary.caseId,
            runId: null,
            skyvernTaskId: summary.runId,
            status: summary.status,
            engine: summary.engine,
            accountEmail: summary.accountEmail || null,
        }).catch(() => null);

        await database.updateCasePortalStatus(summary.caseId, {
            portal_url: summary.portalUrl,
            portal_provider: summary.provider !== 'generic' ? summary.provider : (caseData?.portal_provider || undefined),
            last_portal_status: summary.dryRun ? 'Playwright dry-run started' : 'Playwright run started',
            last_portal_status_at: new Date(),
            last_portal_engine: summary.engine,
            last_portal_run_id: summary.runId,
            last_portal_task_url: null,
            last_portal_recording_url: null,
            last_portal_account_email: summary.accountEmail || null,
        }).catch(() => {});

        return submission;
    }

    async _persistTrackedBrowserSession(caseData, summary, submissionRow, shouldTrackInAutobot) {
        if (!shouldTrackInAutobot || !summary.caseId) return;

        const taskUrl = summary.browser_debugger_url || summary.browser_session_url || null;
        const browserMetadata = summary.browser_metadata && typeof summary.browser_metadata === 'object'
            ? summary.browser_metadata
            : {};
        const liveUrls = summary.browser_live_urls_jsonb && typeof summary.browser_live_urls_jsonb === 'object'
            ? summary.browser_live_urls_jsonb
            : {};

        await database.updateCasePortalStatus(summary.caseId, {
            portal_url: summary.portalUrl,
            portal_provider: summary.provider !== 'generic' ? summary.provider : (caseData?.portal_provider || undefined),
            last_portal_task_url: taskUrl,
            last_portal_recording_url: summary.recording_url || summary.browser_session_url || null,
            last_portal_engine: summary.engine,
            last_portal_run_id: summary.runId,
        }).catch(() => {});

        if (!submissionRow?.id) return;

        await database.updatePortalSubmission(submissionRow.id, {
            browser_backend: summary.browser_backend || null,
            browser_session_id: summary.browser_session_id || null,
            browser_session_url: summary.browser_session_url || null,
            browser_debugger_url: summary.browser_debugger_url || null,
            browser_debugger_fullscreen_url: summary.browser_debugger_fullscreen_url || null,
            browser_region: summary.browser_region || null,
            browser_status: summary.browser_status || null,
            auth_context_id: summary.auth_context_id || null,
            browser_keep_alive: Boolean(summary.browser_keep_alive),
            browser_cost_policy: JSON.stringify(summary.browser_cost_policy || {}),
            browser_metadata: Object.keys(browserMetadata).length > 0 ? JSON.stringify(browserMetadata) : JSON.stringify({}),
            browser_live_urls_jsonb: Object.keys(liveUrls).length > 0 ? JSON.stringify(liveUrls) : JSON.stringify({}),
        }).catch(() => {});
    }

    async _maybeRunPortalScout(caseData, portalUrl, provider, summary, {
        submissionRow = null,
        workerJobId = null,
        reason = null,
    } = {}) {
        if (!DEFAULT_SCOUT_ENABLED) return null;
        if (!portalUrl || !summary?.caseId) return null;
        if (summary.scout?.status) return summary.scout;

        const isAvailable = await portalScout.isAvailable().catch(() => false);
        if (!isAvailable) return null;

        const scoutRow = await database.createPortalScoutRun({
            caseId: summary.caseId,
            portalSubmissionId: submissionRow?.id || null,
            workerJobId: workerJobId || null,
            portalUrl,
            provider: provider || summary.provider || null,
            status: 'started',
            engine: 'lightpanda_scout',
            scoutData: {
                trigger_reason: reason || null,
                source_engine: summary.engine,
                source_status: summary.status,
            },
        }).catch(() => null);

        const scoutResult = await portalScout.scoutPortal(caseData, portalUrl, {
            provider: provider || summary.provider || null,
            artifactsRoot: path.join(summary.artifactsDir, 'scout'),
        }).catch((error) => ({
            success: false,
            status: 'scout_error',
            error: error?.message || String(error),
            pageKind: 'unknown',
            title: null,
            final_url: portalUrl,
            hints: null,
            artifactsDir: path.join(summary.artifactsDir, 'scout'),
        }));

        if (scoutRow?.id) {
            await database.updatePortalScoutRun(scoutRow.id, {
                status: scoutResult.status,
                page_kind: scoutResult.pageKind || null,
                final_url: scoutResult.final_url || portalUrl,
                title: scoutResult.title || null,
                error_message: scoutResult.error ? truncate(scoutResult.error, 500) : null,
                scout_jsonb: scoutResult,
                completed_at: new Date(),
            }).catch(() => null);
        }

        summary.scout = {
            id: scoutRow?.id || null,
            status: scoutResult.status,
            pageKind: scoutResult.pageKind || 'unknown',
            title: scoutResult.title || null,
            blocker: scoutResult.blocker || null,
            topActions: scoutResult.hints?.topActions || [],
            formFieldCount: scoutResult.hints?.formFieldCount || 0,
            artifactsDir: scoutResult.artifactsDir || null,
            provider: scoutResult.provider || provider || summary.provider || null,
        };
        summary.steps.push({
            step: 'portal_scout',
            status: scoutResult.status,
            pageKind: scoutResult.pageKind || 'unknown',
            title: scoutResult.title || null,
            reason: reason || null,
        });

        return summary.scout;
    }

    async _persistTrackedScreenshot(summary, { sourcePath, sequenceIndex, label, status }) {
        if (!summary.caseId || !sourcePath || !fs.existsSync(sourcePath)) return null;

        const persisted = await persistPortalScreenshot({
            caseId: summary.caseId,
            runId: summary.runId,
            sequenceIndex,
            status,
            label,
            sourcePath,
            metadata: {
                engine: summary.engine,
                provider: summary.provider,
                portal_url: summary.final_url || summary.portalUrl,
            },
        }).catch(() => null);

        if (persisted?.publicUrl) {
            summary.screenshot_url = persisted.publicUrl;
        }

        return persisted?.publicUrl || null;
    }

    async _finalizeTrackedRun(caseData, summary, submissionRow, shouldTrackInAutobot) {
        if (!shouldTrackInAutobot || !summary.caseId) return;

        const lastPortalDetails = summary.extracted_data
            ? JSON.stringify(summary.extracted_data)
            : (summary.error ? JSON.stringify({ error: truncate(summary.error, 500) }) : undefined);

        const detailPayload = summary.extracted_data || {};
        if (summary.scout) {
            detailPayload.scout = summary.scout;
        }
        const serializedPortalDetails = Object.keys(detailPayload).length > 0
            ? JSON.stringify(detailPayload)
            : lastPortalDetails;

        await database.updateCasePortalStatus(summary.caseId, {
            portal_url: summary.portalUrl,
            portal_provider: summary.provider !== 'generic' ? summary.provider : (caseData?.portal_provider || undefined),
            last_portal_status: summary.status,
            last_portal_status_at: new Date(),
            last_portal_engine: summary.engine,
            last_portal_run_id: summary.taskId || summary.runId || null,
            last_portal_details: serializedPortalDetails,
            last_portal_task_url: summary.browser_debugger_url || summary.browser_session_url || null,
            last_portal_recording_url: summary.recording_url || summary.browser_session_url || null,
            last_portal_account_email: summary.accountEmail || null,
            last_portal_screenshot_url: summary.screenshot_url || undefined,
        }).catch(() => {});

        if (!submissionRow?.id) return;

        await database.updatePortalSubmission(submissionRow.id, {
            status: summary.status,
            skyvern_task_id: summary.taskId || summary.runId || null,
            screenshot_url: summary.screenshot_url || null,
            recording_url: summary.recording_url || null,
            browser_backend: summary.browser_backend || null,
            browser_session_id: summary.browser_session_id || null,
            browser_session_url: summary.browser_session_url || null,
            browser_debugger_url: summary.browser_debugger_url || null,
            browser_debugger_fullscreen_url: summary.browser_debugger_fullscreen_url || null,
            browser_region: summary.browser_region || null,
            browser_status: summary.browser_status || null,
            auth_context_id: summary.auth_context_id || null,
            auth_intervention_status: summary.auth_intervention_status || null,
            auth_intervention_reason: summary.auth_intervention_reason || null,
            auth_intervention_requested_at: summary.auth_intervention_requested_at || null,
            auth_intervention_completed_at: summary.auth_intervention_completed_at || null,
            browser_keep_alive: Boolean(summary.browser_keep_alive),
            browser_cost_policy: JSON.stringify(summary.browser_cost_policy || {}),
            browser_metadata: JSON.stringify(summary.browser_metadata || {}),
            browser_live_urls_jsonb: JSON.stringify(summary.browser_live_urls_jsonb || {}),
            extracted_data: serializedPortalDetails,
            error_message: summary.error ? truncate(summary.error, 500) : null,
            completed_at: new Date(),
        }).catch(() => {});
    }

    async _safePageContent(page) {
        try {
            return await page.content();
        } catch (error) {
            await page.waitForTimeout(750).catch(() => {});
            try {
                return await page.content();
            } catch (retryError) {
                return `<!-- page content unavailable: ${truncate(retryError?.message || String(retryError), 240)} -->`;
            }
        }
    }

    async _writeJson(filePath, data) {
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    async _writeText(filePath, text) {
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, String(text || ''));
    }
}

const service = new PortalAgentServicePlaywright();
service.PortalAgentServicePlaywright = PortalAgentServicePlaywright;
service.normalizeProviderName = normalizeProviderName;
service.normalizeBrowserBackend = normalizeBrowserBackend;
service.resolveBrowserBackendSelection = resolveBrowserBackendSelection;
service.coerceBrowserbaseOs = coerceBrowserbaseOs;
service.buildBrowserbaseLaunchOptions = buildBrowserbaseLaunchOptions;
service.buildBrowserbaseCostPolicy = buildBrowserbaseCostPolicy;
service.shouldUseBrowserbaseAuthContext = shouldUseBrowserbaseAuthContext;
service.buildBrowserbaseProxyPolicy = buildBrowserbaseProxyPolicy;
service.isBrowserbaseAuthInterventionState = isBrowserbaseAuthInterventionState;
service.isSupportedPlaywrightUrl = isSupportedPlaywrightUrl;
service.scoreGovQaRequestLink = scoreGovQaRequestLink;
service.scoreJustFoiaLaunchLink = scoreJustFoiaLaunchLink;
service.scoreSubmitControlCandidates = scoreSubmitControlCandidates;
service.isCaptchaLikeField = isCaptchaLikeField;
service.mapFieldValue = mapFieldValue;
service.buildRequestNarrative = buildRequestNarrative;
service.buildPortalCredentialProfile = buildPortalCredentialProfile;
service.buildPortalActionUrl = buildPortalActionUrl;
service.inferNextRequestLinkKind = inferNextRequestLinkKind;

module.exports = service;
