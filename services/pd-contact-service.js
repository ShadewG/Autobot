const axios = require('axios');
const { Client } = require('@notionhq/client');

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PD_DATABASE_ID = process.env.NOTION_POLICE_DEPT_DATABASE_ID;

// Lazy-init Notion client (only when needed)
let notionClient = null;
function getNotion() {
    if (!notionClient && NOTION_API_KEY) {
        notionClient = new Client({ auth: NOTION_API_KEY });
    }
    return notionClient;
}

/**
 * Extract plain value from a Notion property.
 */
function extractNotionValue(prop) {
    if (!prop) return null;
    switch (prop.type) {
        case 'title':
            return prop.title?.[0]?.plain_text || null;
        case 'rich_text':
            return prop.rich_text?.map(t => t.plain_text).join('') || null;
        case 'url':
            return prop.url || null;
        case 'email':
            return prop.email || null;
        case 'phone_number':
            return prop.phone_number || null;
        default:
            return null;
    }
}

/**
 * Pre-check: Query the Notion Police Departments database directly.
 * Returns cached contact data if the department already has portal/email info.
 */
async function preCheck(departmentName, location) {
    const notion = getNotion();
    if (!notion || !NOTION_PD_DATABASE_ID) {
        console.log('pd-contact pre-check: Notion not configured, skipping');
        return null;
    }

    try {
        const response = await notion.databases.query({
            database_id: NOTION_PD_DATABASE_ID,
            filter: {
                property: 'Department Name',
                title: { contains: departmentName }
            },
            page_size: 5
        });

        if (!response.results || response.results.length === 0) {
            console.log(`pd-contact pre-check: no Notion match for "${departmentName}"`);
            return null;
        }

        // Find best match — prefer exact match, then first result
        let bestPage = response.results[0];
        for (const page of response.results) {
            const pageName = extractNotionValue(page.properties['Department Name']);
            if (pageName && pageName.toLowerCase() === departmentName.toLowerCase()) {
                bestPage = page;
                break;
            }
        }

        const props = bestPage.properties;
        const portalUrl = extractNotionValue(props['Portal/ Online Form']);
        const portalUrlAlt = extractNotionValue(props['Portal/ Online Form (1)']);
        const emailCorrespondence = extractNotionValue(props['Email Correspondence']);
        const contactPhone = extractNotionValue(props['Contact Phone']);
        const contactName = extractNotionValue(props['Name Of Officer/Employee Contacted']);
        const deptName = extractNotionValue(props['Department Name']);

        const effectivePortal = portalUrl || portalUrlAlt;
        // Email Correspondence is a URL-type field; strip mailto: prefix if present
        const effectiveEmail = emailCorrespondence?.replace(/^mailto:/i, '') || null;

        if (!effectivePortal && !effectiveEmail) {
            console.log(`pd-contact pre-check: Notion page found for "${departmentName}" but no contact info`);
            return { pageId: bestPage.id, departmentName: deptName, hasContact: false };
        }

        console.log(`pd-contact pre-check hit for "${departmentName}": portal=${effectivePortal || 'none'}, email=${effectiveEmail || 'none'}`);

        return {
            pageId: bestPage.id,
            departmentName: deptName,
            hasContact: true,
            contact: {
                portal_url: effectivePortal,
                portal_provider: null,
                contact_email: effectiveEmail,
                contact_phone: contactPhone,
                mailing_address: null,
                records_officer: contactName,
                confidence: null,
                notes: 'Notion PD database (cached)',
                source: 'pd-contact'
            }
        };
    } catch (err) {
        console.warn(`pd-contact pre-check error for "${departmentName}":`, err.message);
        return null;
    }
}

/**
 * Full search: Call Firecrawl v2 Agent API to research department contact info.
 * Polls for completion (max ~6 minutes).
 */
async function firecrawlSearch(departmentName, location) {
    if (!FIRECRAWL_API_KEY) {
        console.log('pd-contact firecrawl: FIRECRAWL_API_KEY not set, skipping');
        return null;
    }

    const locationStr = location ? ` in ${location}` : '';
    const prompt = `Find the FOIA (Freedom of Information Act) or public records request contact information for "${departmentName}"${locationStr}. I need:
1. The online FOIA/public records request portal URL (if they have one)
2. The email address for submitting FOIA/public records requests
3. The phone number for the records department
4. The name of the records custodian or FOIA officer
5. The mailing address for records requests
6. What type of portal system they use (e.g., JustFOIA, NextRequest, GovQA, custom)

Search the department's official website and any FOIA-related pages. Look for "records request", "FOIA", "public records", "open records", or "freedom of information" pages.`;

    const schema = {
        type: 'object',
        properties: {
            foia_portal_url: {
                type: 'string',
                description: 'URL of the online FOIA/public records request portal or form'
            },
            portal_type: {
                type: 'string',
                description: 'Type of portal system (e.g., JustFOIA, NextRequest, GovQA, custom form, none)'
            },
            foia_email: {
                type: 'string',
                description: 'Email address for submitting FOIA/public records requests'
            },
            foia_phone: {
                type: 'string',
                description: 'Phone number for the records department'
            },
            records_officer_name: {
                type: 'string',
                description: 'Name of the records custodian or FOIA officer'
            },
            mailing_address: {
                type: 'string',
                description: 'Mailing address for records requests'
            },
            foia_instructions: {
                type: 'string',
                description: 'Any specific instructions or notes about the FOIA process'
            },
            confidence_score: {
                type: 'number',
                description: 'Confidence score from 0-1 that the information is correct and current'
            }
        },
        required: ['foia_portal_url', 'foia_email', 'confidence_score']
    };

    try {
        // Start agent job
        console.log(`pd-contact firecrawl: starting agent search for "${departmentName}"${locationStr}`);
        const startRes = await axios.post('https://api.firecrawl.dev/v2/agent', {
            prompt,
            schema
        }, {
            headers: {
                'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 90000 // Firecrawl can take 30-60s to accept the job
        });

        const jobId = startRes.data?.id || startRes.data?.jobId;
        if (!jobId) {
            console.warn('pd-contact firecrawl: no jobId returned from agent start', startRes.data);
            return null;
        }

        console.log(`pd-contact firecrawl: agent job ${jobId} started, polling...`);

        // Poll for completion — max 120 polls × 3s = 6 minutes
        for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 3000));

            const pollRes = await axios.get(`https://api.firecrawl.dev/v2/agent/${jobId}`, {
                headers: { 'Authorization': `Bearer ${FIRECRAWL_API_KEY}` },
                timeout: 15000
            });

            const status = pollRes.data?.status;
            if (status === 'completed' || status === 'done') {
                const data = pollRes.data?.data || pollRes.data?.result || pollRes.data?.output;
                if (!data) {
                    console.warn('pd-contact firecrawl: completed but no data', pollRes.data);
                    return null;
                }

                console.log(`pd-contact firecrawl: agent completed for "${departmentName}" after ${(i + 1) * 3}s`);
                return normalizeResult(data);
            }

            if (status === 'failed' || status === 'error') {
                console.warn(`pd-contact firecrawl: agent failed for "${departmentName}":`, pollRes.data?.error || pollRes.data?.message);
                return null;
            }

            // Still running — continue polling
        }

        console.warn(`pd-contact firecrawl: agent timed out after 6 minutes for "${departmentName}"`);
        return null;
    } catch (err) {
        console.warn(`pd-contact firecrawl: error for "${departmentName}":`, err.message);
        return null;
    }
}

/**
 * Save research results back to the Notion PD page (fire-and-forget).
 */
async function saveToNotion(pageId, contactData) {
    const notion = getNotion();
    if (!notion || !pageId) return;

    try {
        const properties = {};

        if (contactData.portal_url) {
            properties['Portal/ Online Form'] = { url: contactData.portal_url };
        }
        if (contactData.contact_email) {
            // Email Correspondence is a url-type property in Notion
            properties['Email Correspondence'] = { url: `mailto:${contactData.contact_email}` };
        }
        if (contactData.contact_phone) {
            properties['Contact Phone'] = {
                rich_text: [{ text: { content: contactData.contact_phone } }]
            };
        }
        if (contactData.records_officer) {
            properties['Name Of Officer/Employee Contacted'] = {
                rich_text: [{ text: { content: contactData.records_officer } }]
            };
        }

        if (Object.keys(properties).length > 0) {
            await notion.pages.update({ page_id: pageId, properties });
            console.log(`pd-contact saveToNotion: updated page ${pageId}`);
        }
    } catch (err) {
        console.warn('pd-contact saveToNotion failed:', err.message);
    }
}

/**
 * Combined lookup: Notion pre-check first, Firecrawl full search if needed,
 * save-to-Notion in background.
 * Returns normalized contact data or null on failure.
 */
async function lookupContact(name, location) {
    if (!name) return null;

    // 1. Try fast Notion pre-check
    const quick = await preCheck(name, location);
    if (quick?.hasContact && quick.contact) {
        return quick.contact;
    }

    // 2. Full Firecrawl search
    const result = await firecrawlSearch(name, location);
    if (!result) return null;

    console.log(`pd-contact full search for "${name}": portal=${result.portal_url || 'none'}, email=${result.contact_email || 'none'}, confidence=${result.confidence || 'unknown'}`);

    // 3. Save to Notion in background (fire-and-forget)
    if (result.portal_url || result.contact_email) {
        const pageId = quick?.pageId || null;
        if (pageId) {
            saveToNotion(pageId, result).catch(() => {});
        }
    }

    return result;
}

/**
 * Normalize Firecrawl/API result fields to our internal format.
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

module.exports = { preCheck, firecrawlSearch, saveToNotion, lookupContact };
