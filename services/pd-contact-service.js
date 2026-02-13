const axios = require('axios');

const BASE_URL = process.env.PD_CONTACT_API_URL || 'http://localhost:8000';
const API_PREFIX = '/api/pd-lookup';

async function preCheck(departmentName, location) {
    const res = await axios.post(`${BASE_URL}${API_PREFIX}/pre-check`, {
        department_name: departmentName,
        location
    }, { timeout: 15000 });
    return res.data;
}

async function search(departmentName, location) {
    const res = await axios.post(`${BASE_URL}${API_PREFIX}/search`, {
        department_name: departmentName,
        location
    }, { timeout: 360000 }); // Firecrawl agent can take up to 6 minutes
    return res.data;
}

async function saveToNotion(departmentName, location, contactData) {
    try {
        await axios.post(`${BASE_URL}${API_PREFIX}/save-to-notion`, {
            department_name: departmentName,
            location,
            foia_portal_url: contactData.portal_url || null,
            foia_email: contactData.contact_email || null,
            foia_phone: contactData.contact_phone || null,
            mailing_address: contactData.mailing_address || null,
            records_officer_name: contactData.records_officer || null,
            portal_type: contactData.portal_provider || null,
            has_online_portal: !!contactData.portal_url
        }, { timeout: 15000 });
    } catch (err) {
        console.warn('pd-contact saveToNotion failed:', err.message);
    }
}

/**
 * Combined lookup: pre-check first, full search if needed, save-to-Notion in background.
 * Returns normalized contact data or null on failure.
 */
async function lookupContact(name, location) {
    if (!name) return null;

    // Detect connection issues early so callers can show the right error
    const isConnectionError = (err) =>
        err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND';

    // Try fast cache/Notion check first
    try {
        const quick = await preCheck(name, location);
        const cached = quick.cached_data;
        if (cached && (cached.foia_portal_url || cached.foia_email)) {
            console.log(`pd-contact pre-check hit for "${name}": portal=${cached.foia_portal_url || 'none'}, email=${cached.foia_email || 'none'}`);
            return normalizeResult(cached);
        }
        // If pre-check found a Notion page with contact email but no cached_data
        if (quick.has_contact_info && quick.notion_contact_email) {
            console.log(`pd-contact pre-check Notion hit for "${name}": email=${quick.notion_contact_email}`);
            return {
                portal_url: null,
                portal_provider: null,
                contact_email: quick.notion_contact_email,
                contact_phone: null,
                mailing_address: null,
                records_officer: null,
                confidence: null,
                notes: `Notion record (${quick.match_type || 'exact'} match)`,
                source: 'pd-contact'
            };
        }
    } catch (err) {
        if (isConnectionError(err)) {
            const error = new Error(`pd-contact service unavailable at ${BASE_URL}`);
            error.code = 'SERVICE_UNAVAILABLE';
            throw error;
        }
        console.log(`pd-contact pre-check miss for "${name}": ${err.message}`);
    }

    // Full Firecrawl search
    try {
        const result = await search(name, location);
        if (!result || !result.success || !result.data) {
            if (result && result.error) {
                console.warn(`pd-contact search error for "${name}": ${result.error}`);
            }
            return null;
        }

        const normalized = normalizeResult(result.data);

        // Save to Notion in background (don't block)
        if (normalized.portal_url || normalized.contact_email) {
            saveToNotion(name, location, normalized).catch(() => {});
        }

        console.log(`pd-contact full search for "${name}": portal=${normalized.portal_url || 'none'}, email=${normalized.contact_email || 'none'}, confidence=${normalized.confidence || 'unknown'}`);
        return normalized;
    } catch (err) {
        if (isConnectionError(err)) {
            const error = new Error(`pd-contact service unavailable at ${BASE_URL}`);
            error.code = 'SERVICE_UNAVAILABLE';
            throw error;
        }
        console.warn(`pd-contact search failed for "${name}":`, err.message);
        return null;
    }
}

/**
 * Normalize PDContactInfo fields from the API to our internal field names.
 */
function normalizeResult(data) {
    if (!data) return null;
    return {
        portal_url: data.foia_portal_url || null,
        portal_provider: data.portal_type || null,
        contact_email: data.foia_email || null,
        contact_phone: data.foia_phone || null,
        mailing_address: data.mailing_address || null,
        records_officer: data.records_officer_name || null,
        confidence: data.confidence_score || null,
        notes: data.foia_instructions || null,
        source: 'pd-contact'
    };
}

module.exports = { preCheck, search, saveToNotion, lookupContact };
