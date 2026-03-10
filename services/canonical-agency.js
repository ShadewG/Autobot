const { normalizePortalUrl } = require('../utils/portal-utils');

const STATE_NAME_BY_CODE = {
    AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
    CO: 'colorado', CT: 'connecticut', DE: 'delaware', DC: 'district of columbia',
    FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
    IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana',
    ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan',
    MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
    NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey',
    NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota',
    OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
    RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee',
    TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
    WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
};

const STATE_SUFFIX_PATTERN = new RegExp(
    `,\\s*(?:${Object.values(STATE_NAME_BY_CODE).map((name) => name.replace(/\s+/g, '\\\\s+')).join('|')})\\.?$`,
    'i'
);

function normalizeAgencyEmailHint(email) {
    const value = String(email || '').trim().toLowerCase().replace(/^mailto:/, '');
    return value.includes('@') ? value : null;
}

function isTestAgencyEmail(email) {
    const normalized = normalizeAgencyEmailHint(email);
    if (!normalized) return false;
    const configured = normalizeAgencyEmailHint(process.env.DEFAULT_TEST_EMAIL || 'shadewofficial@gmail.com');
    return normalized === configured;
}

function normalizeAgencyTenantHint(value) {
    const lower = String(value || '').trim().toLowerCase();
    if (!lower) return '';
    const compact = lower.replace(/[^a-z0-9]/g, '');
    const match = compact.match(/^([a-z]{4,})([a-z]{2})$/);
    if (!match) return compact;
    const stateCodes = new Set([
        'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il',
        'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt',
        'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri',
        'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc'
    ]);
    return stateCodes.has(match[2]) ? match[1] : compact;
}

function normalizeAgencyNameHint(value) {
    return String(value || '')
        .replace(/[.]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAgencyComparable(value) {
    return normalizeAgencyNameHint(value)
        .toLowerCase()
        .replace(/[’'`´]/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildAgencyNameBaseHint(value) {
    const normalized = normalizeAgencyNameHint(value)
        .replace(STATE_SUFFIX_PATTERN, '')
        .split(/[–—/]/)[0]
        .split('(')[0]
        .trim();
    return normalized;
}

async function findCanonicalAgency(db, { portalUrl, portalMailbox, agencyEmail, agencyName, stateHint }) {
    const normalizedPortalUrl = normalizePortalUrl(portalUrl);
    const normalizedAgencyEmail = isTestAgencyEmail(agencyEmail) ? null : normalizeAgencyEmailHint(agencyEmail);
    const normalizedPortalMailbox = isTestAgencyEmail(portalMailbox) ? null : normalizeAgencyEmailHint(portalMailbox);
    const portalHost = normalizedPortalUrl ? new URL(normalizedPortalUrl).hostname.toLowerCase() : null;
    const portalTenantHint = normalizeAgencyTenantHint(portalHost ? portalHost.split('.')[0] : '');
    const mailboxTenantHint = normalizeAgencyTenantHint(normalizedPortalMailbox ? normalizedPortalMailbox.split('@')[0] : '');
    const normalizedAgencyName = normalizeAgencyNameHint(agencyName);
    const comparableAgencyName = normalizeAgencyComparable(normalizedAgencyName);
    const agencyBaseName = buildAgencyNameBaseHint(normalizedAgencyName);
    const comparableAgencyBaseName = normalizeAgencyComparable(agencyBaseName);
    const normalizedStateHint = stateHint && stateHint !== '{}' ? String(stateHint).trim() : null;
    const stateNameHint = normalizedStateHint ? (STATE_NAME_BY_CODE[normalizedStateHint.toUpperCase()] || '') : '';

    const candidateQuery = await db.query(
        `SELECT
            a.id,
            a.name,
            a.state,
            a.email_main,
            a.email_foia,
            a.portal_url,
            a.portal_url_alt,
            a.portal_provider,
            (
                CASE
                    WHEN $1::text IS NOT NULL AND (
                        LOWER(COALESCE(a.portal_url, '')) = LOWER($1)
                        OR LOWER(COALESCE(a.portal_url_alt, '')) = LOWER($1)
                    ) THEN 20 ELSE 0
                END
                + CASE
                    WHEN $2::text IS NOT NULL AND (
                        LOWER(COALESCE(a.email_main, '')) = LOWER($2)
                        OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) = LOWER($2)
                    ) THEN 15 ELSE 0
                END
                + CASE
                    WHEN $3::text IS NOT NULL AND (
                        LOWER(COALESCE(a.email_main, '')) = LOWER($3)
                        OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) = LOWER($3)
                    ) THEN 12 ELSE 0
                END
                + CASE
                    WHEN $4::text <> '' AND (
                        LOWER(a.name) LIKE '%' || $4 || '%'
                        OR LOWER(COALESCE(a.portal_url, '')) LIKE '%' || $4 || '%'
                        OR LOWER(COALESCE(a.portal_url_alt, '')) LIKE '%' || $4 || '%'
                        OR LOWER(COALESCE(a.email_main, '')) LIKE '%' || $4 || '%'
                        OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) LIKE '%' || $4 || '%'
                    ) THEN 8 ELSE 0
                END
                + CASE
                    WHEN $5::text <> '' AND (
                        LOWER(a.name) LIKE '%' || $5 || '%'
                        OR LOWER(COALESCE(a.portal_url, '')) LIKE '%' || $5 || '%'
                        OR LOWER(COALESCE(a.portal_url_alt, '')) LIKE '%' || $5 || '%'
                        OR LOWER(COALESCE(a.email_main, '')) LIKE '%' || $5 || '%'
                        OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) LIKE '%' || $5 || '%'
                    ) THEN 7 ELSE 0
                END
                + CASE
                    WHEN $6::text <> '' AND LOWER(a.name) = LOWER($6) THEN 10 ELSE 0
                END
                + CASE
                    WHEN $7::text <> '' AND regexp_replace(lower(a.name), '[^a-z0-9]+', ' ', 'g') = $7 THEN 9 ELSE 0
                END
                + CASE
                    WHEN $8::text <> '' AND regexp_replace(lower(a.name), '[^a-z0-9]+', ' ', 'g') LIKE '%' || $8 || '%'
                     AND (
                        ($9::text IS NOT NULL AND a.state = $9)
                        OR ($10::text <> '' AND LOWER(a.name) LIKE '%' || $10 || '%')
                     )
                    THEN 8 ELSE 0
                END
                + CASE
                    WHEN $9::text IS NOT NULL AND a.state = $9 THEN 2 ELSE 0
                END
            ) AS score,
            (
                CASE WHEN a.email_main IS NOT NULL THEN 1 ELSE 0 END
                + CASE WHEN a.email_foia IS NOT NULL THEN 1 ELSE 0 END
                + CASE WHEN a.portal_url IS NOT NULL THEN 1 ELSE 0 END
                + CASE WHEN a.state IS NOT NULL AND a.state <> '{}' THEN 1 ELSE 0 END
            ) AS completeness
         FROM agencies a
         WHERE
            ($1::text IS NOT NULL AND (
                LOWER(COALESCE(a.portal_url, '')) = LOWER($1)
                OR LOWER(COALESCE(a.portal_url_alt, '')) = LOWER($1)
            ))
            OR ($2::text IS NOT NULL AND (
                LOWER(COALESCE(a.email_main, '')) = LOWER($2)
                OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) = LOWER($2)
            ))
            OR ($3::text IS NOT NULL AND (
                LOWER(COALESCE(a.email_main, '')) = LOWER($3)
                OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) = LOWER($3)
            ))
            OR ($4::text <> '' AND (
                LOWER(a.name) LIKE '%' || $4 || '%'
                OR LOWER(COALESCE(a.portal_url, '')) LIKE '%' || $4 || '%'
                OR LOWER(COALESCE(a.portal_url_alt, '')) LIKE '%' || $4 || '%'
                OR LOWER(COALESCE(a.email_main, '')) LIKE '%' || $4 || '%'
                OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) LIKE '%' || $4 || '%'
            ))
            OR ($5::text <> '' AND (
                LOWER(a.name) LIKE '%' || $5 || '%'
                OR LOWER(COALESCE(a.portal_url, '')) LIKE '%' || $5 || '%'
                OR LOWER(COALESCE(a.portal_url_alt, '')) LIKE '%' || $5 || '%'
                OR LOWER(COALESCE(a.email_main, '')) LIKE '%' || $5 || '%'
                OR LOWER(REPLACE(COALESCE(a.email_foia, ''), 'mailto:', '')) LIKE '%' || $5 || '%'
            ))
            OR ($6::text <> '' AND LOWER(a.name) = LOWER($6))
            OR ($7::text <> '' AND regexp_replace(lower(a.name), '[^a-z0-9]+', ' ', 'g') = $7)
            OR ($8::text <> '' AND regexp_replace(lower(a.name), '[^a-z0-9]+', ' ', 'g') LIKE '%' || $8 || '%')
         ORDER BY score DESC, completeness DESC, a.id DESC
         LIMIT 5`,
        [
            normalizedPortalUrl,
            normalizedAgencyEmail,
            normalizedPortalMailbox,
            portalTenantHint,
            mailboxTenantHint,
            normalizedAgencyName,
            comparableAgencyName,
            comparableAgencyBaseName && comparableAgencyBaseName !== comparableAgencyName ? comparableAgencyBaseName : '',
            normalizedStateHint,
            stateNameHint,
        ]
    );

    const best = candidateQuery.rows[0];
    return best && Number(best.score || 0) >= 8 ? best : null;
}

module.exports = {
    normalizeAgencyEmailHint,
    isTestAgencyEmail,
    findCanonicalAgency,
};
