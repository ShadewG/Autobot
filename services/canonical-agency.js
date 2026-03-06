const { normalizePortalUrl } = require('../utils/portal-utils');

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

async function findCanonicalAgency(db, { portalUrl, portalMailbox, agencyEmail, agencyName, stateHint }) {
    const normalizedPortalUrl = normalizePortalUrl(portalUrl);
    const normalizedAgencyEmail = isTestAgencyEmail(agencyEmail) ? null : normalizeAgencyEmailHint(agencyEmail);
    const normalizedPortalMailbox = isTestAgencyEmail(portalMailbox) ? null : normalizeAgencyEmailHint(portalMailbox);
    const portalHost = normalizedPortalUrl ? new URL(normalizedPortalUrl).hostname.toLowerCase() : null;
    const portalTenantHint = normalizeAgencyTenantHint(portalHost ? portalHost.split('.')[0] : '');
    const mailboxTenantHint = normalizeAgencyTenantHint(normalizedPortalMailbox ? normalizedPortalMailbox.split('@')[0] : '');
    const normalizedAgencyName = String(agencyName || '').trim();
    const normalizedStateHint = stateHint && stateHint !== '{}' ? String(stateHint).trim() : null;

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
                    WHEN $6::text <> '' AND LOWER(a.name) = LOWER($6) THEN 6 ELSE 0
                END
                + CASE
                    WHEN $7::text IS NOT NULL AND a.state = $7 THEN 2 ELSE 0
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
         ORDER BY score DESC, completeness DESC, a.id DESC
         LIMIT 5`,
        [
            normalizedPortalUrl,
            normalizedAgencyEmail,
            normalizedPortalMailbox,
            portalTenantHint,
            mailboxTenantHint,
            normalizedAgencyName,
            normalizedStateHint,
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
