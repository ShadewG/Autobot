/**
 * Shared US state utilities — maps full names ↔ 2-letter codes.
 */

const STATE_ABBREVIATIONS = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
    'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'district of columbia': 'DC',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL',
    'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA',
    'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA', 'michigan': 'MI',
    'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT',
    'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
    'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA',
    'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN',
    'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
    'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
};

const VALID_STATE_CODES = new Set(Object.values(STATE_ABBREVIATIONS));

/**
 * Normalize any state representation to a 2-letter code.
 * Accepts: "AL", "Alabama", "alabama", "New York", "NY", etc.
 * Returns null if unrecognizable.
 */
function normalizeStateCode(value) {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Already a valid 2-letter code?
    const upper = trimmed.toUpperCase();
    if (/^[A-Z]{2}$/.test(upper) && VALID_STATE_CODES.has(upper)) return upper;

    // Full name lookup
    const code = STATE_ABBREVIATIONS[trimmed.toLowerCase()];
    if (code) return code;

    return null;
}

/**
 * Extract a state code from the trailing ", State" or ", XX" suffix of an agency name.
 * E.g. "Lawrence County Sheriff's Office, Alabama" → "AL"
 *      "Milford PD, Iowa" → "IA"
 * Returns null if no state found.
 */
function parseStateFromAgencyName(agencyName) {
    if (!agencyName) return null;
    const match = agencyName.match(/,\s*([^,]+)$/);
    if (!match) return null;
    return normalizeStateCode(match[1]);
}

module.exports = { STATE_ABBREVIATIONS, VALID_STATE_CODES, normalizeStateCode, parseStateFromAgencyName };
