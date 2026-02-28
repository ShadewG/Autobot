const sgMail = require('@sendgrid/mail');
const crypto = require('crypto');
const db = require('../../services/database');
const notionService = require('../../services/notion-service');
const discordService = require('../../services/discord-service');
const aiService = require('../../services/ai-service');
const { emailQueue, generateQueue, portalQueue } = require('../../queues/email-queue');
const { extractUrls } = require('../../utils/contact-utils');
const { normalizePortalUrl, isSupportedPortalUrl, detectPortalProviderByUrl } = require('../../utils/portal-utils');
const PORTAL_ACTIVITY_EVENTS = require('../../utils/portal-activity-events');
const { transitionCaseRuntime } = require('../../services/case-runtime');

function safeJsonParse(value, defaultValue = null) {
    if (!value) {
        return defaultValue;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        console.warn('Failed to parse JSON field:', error.message);
        return defaultValue;
    }
}

function normalizePortalEvents(rawEvents) {
    const parsed = safeJsonParse(rawEvents, rawEvents);
    if (!parsed) {
        return [];
    }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
        .filter(Boolean)
        .map((event) => {
            const metadata = safeJsonParse(event.metadata, event.metadata || {});
            return {
                event_type: event.event_type || event.eventType || 'unknown',
                description: event.description || '',
                created_at: event.created_at || event.createdAt || null,
                metadata
            };
        });
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const POLICE_DEPT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const policeDeptLinkCache = new Map();

function buildNotionUrl(pageId) {
    if (!pageId) {
        return null;
    }
    const cleanId = pageId.replace(/-/g, '');
    return `https://www.notion.so/${cleanId}`;
}

async function resolvePoliceDeptPageId(notionPageId) {
    if (!notionPageId || !notionService?.notion) {
        return null;
    }

    const cacheEntry = policeDeptLinkCache.get(notionPageId);
    const now = Date.now();
    if (cacheEntry && (now - cacheEntry.timestamp) < POLICE_DEPT_CACHE_TTL) {
        return cacheEntry.value;
    }

    try {
        const page = await notionService.notion.pages.retrieve({
            page_id: notionPageId.replace(/-/g, '')
        });

        const properties = page.properties || {};
        const preferredKeys = [
            'Police Department',
            'Police Dept',
            'Police Departments',
            'Police Department ',
            'PD',
            'Agency',
            'Department'
        ];

        let relationProperty = null;
        for (const key of preferredKeys) {
            if (properties[key]?.type === 'relation') {
                relationProperty = properties[key];
                break;
            }
        }

        if (!relationProperty) {
            const fallbackEntry = Object.entries(properties).find(([name, prop]) => (
                prop?.type === 'relation' && /police|dept|agency/i.test(name)
            ));
            if (fallbackEntry) {
                relationProperty = fallbackEntry[1];
            }
        }

        const policeDeptPageId = relationProperty?.relation?.[0]?.id || null;
        policeDeptLinkCache.set(notionPageId, { value: policeDeptPageId, timestamp: now });
        return policeDeptPageId;
    } catch (error) {
        console.error('Failed to fetch police department relation from Notion:', error.message);
        throw error;
    }
}

module.exports = {
    db,
    notionService,
    discordService,
    aiService,
    sgMail,
    crypto,
    emailQueue,
    generateQueue,
    portalQueue,
    extractUrls,
    normalizePortalUrl,
    isSupportedPortalUrl,
    detectPortalProviderByUrl,
    PORTAL_ACTIVITY_EVENTS,
    safeJsonParse,
    normalizePortalEvents,
    buildNotionUrl,
    resolvePoliceDeptPageId,
    transitionCaseRuntime
};
