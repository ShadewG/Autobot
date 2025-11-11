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
    }
];

function normalizePortalUrl(url) {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

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

function isSupportedPortalUrl(url) {
    if (!url) return false;

    const normalized = normalizePortalUrl(url);
    if (!normalized) return false;

    try {
        const urlObj = new URL(normalized);
        const pathname = urlObj.pathname.toLowerCase();

        // Reject PDF files
        if (pathname.endsWith('.pdf')) {
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
    normalizePortalUrl,
    detectPortalProviderByUrl,
    detectPortalProviderByHostname,
    isSupportedPortalUrl
};
