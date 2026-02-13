const express = require('express');
const router = express.Router();
const db = require('../services/database');
const notionService = require('../services/notion-service');

/**
 * GET /api/cases/:id/agencies
 * List all agencies for a case
 */
router.get('/:id/agencies', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });

        const includeInactive = req.query.includeInactive === 'true';
        const agencies = await db.getCaseAgencies(caseId, includeInactive);
        res.json({ success: true, agencies });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cases/:id/agencies
 * Add an agency to a case
 */
router.post('/:id/agencies', express.json(), async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });

        const { agency_name, agency_email, portal_url, portal_provider, notes, added_source } = req.body;
        if (!agency_name) return res.status(400).json({ success: false, error: 'agency_name is required' });

        // Try to find matching agency in agencies table
        const matchedAgency = await db.findAgencyByName(agency_name);

        const caseAgency = await db.addCaseAgency(caseId, {
            agency_name,
            agency_email: agency_email || matchedAgency?.email_main || null,
            portal_url: portal_url || matchedAgency?.portal_url || null,
            portal_provider: portal_provider || null,
            agency_id: matchedAgency?.id || null,
            notes,
            added_source: added_source || 'manual'
        });

        await db.logActivity('case_agency_added', `Added agency "${agency_name}" to case ${caseId}`, {
            case_id: caseId,
            case_agency_id: caseAgency.id,
            added_source: added_source || 'manual'
        });

        res.json({ success: true, case_agency: caseAgency });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PATCH /api/cases/:id/agencies/:caId
 * Update agency fields
 */
router.patch('/:id/agencies/:caId', express.json(), async (req, res) => {
    try {
        const caseAgencyId = parseInt(req.params.caId, 10);
        if (!caseAgencyId) return res.status(400).json({ success: false, error: 'Invalid case_agency id' });

        const allowed = [
            'agency_name', 'agency_email', 'portal_url', 'portal_provider',
            'status', 'substatus', 'notes', 'contact_research_notes'
        ];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }

        const updated = await db.updateCaseAgency(caseAgencyId, updates);
        if (!updated) return res.status(404).json({ success: false, error: 'Case agency not found' });

        res.json({ success: true, case_agency: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/cases/:id/agencies/:caId
 * Remove (deactivate) an agency
 */
router.delete('/:id/agencies/:caId', async (req, res) => {
    try {
        const caseAgencyId = parseInt(req.params.caId, 10);
        if (!caseAgencyId) return res.status(400).json({ success: false, error: 'Invalid case_agency id' });

        const removed = await db.removeCaseAgency(caseAgencyId);
        if (!removed) return res.status(404).json({ success: false, error: 'Case agency not found' });

        await db.logActivity('case_agency_removed', `Removed agency "${removed.agency_name}" from case ${removed.case_id}`, {
            case_id: removed.case_id,
            case_agency_id: caseAgencyId
        });

        res.json({ success: true, removed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cases/:id/agencies/:caId/set-primary
 * Switch primary agency
 */
router.post('/:id/agencies/:caId/set-primary', async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        const caseAgencyId = parseInt(req.params.caId, 10);
        if (!caseId || !caseAgencyId) return res.status(400).json({ success: false, error: 'Invalid ids' });

        const newPrimary = await db.switchPrimaryAgency(caseId, caseAgencyId);
        if (!newPrimary) return res.status(404).json({ success: false, error: 'Case agency not found' });

        await db.logActivity('case_agency_primary_switched', `Switched primary agency to "${newPrimary.agency_name}" for case ${caseId}`, {
            case_id: caseId,
            case_agency_id: caseAgencyId
        });

        res.json({ success: true, primary: newPrimary });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cases/:id/agencies/from-notion
 * Add an agency from a Notion page URL or ID
 */
router.post('/:id/agencies/from-notion', express.json(), async (req, res) => {
    try {
        const caseId = parseInt(req.params.id, 10);
        if (!caseId) return res.status(400).json({ success: false, error: 'Invalid case id' });

        let { notion_url } = req.body;
        if (!notion_url) return res.status(400).json({ success: false, error: 'notion_url is required' });

        // Extract page ID from Notion URL or raw ID
        let pageId = notion_url.trim();
        // Handle full URLs like https://www.notion.so/Page-Title-abc123def456...
        const urlMatch = pageId.match(/([a-f0-9]{32}|[a-f0-9-]{36})(?:\?|$)/i);
        if (urlMatch) {
            pageId = urlMatch[1];
        }
        // Remove dashes for consistent format
        pageId = pageId.replace(/-/g, '');

        if (!/^[a-f0-9]{32}$/i.test(pageId)) {
            return res.status(400).json({ success: false, error: 'Could not extract a valid Notion page ID from the URL' });
        }

        // Format as UUID
        const formattedId = `${pageId.slice(0,8)}-${pageId.slice(8,12)}-${pageId.slice(12,16)}-${pageId.slice(16,20)}-${pageId.slice(20)}`;

        // Check if this agency already exists in agencies table
        let agency = await db.query(
            'SELECT * FROM agencies WHERE notion_page_id = $1 OR notion_page_id = $2',
            [pageId, formattedId]
        );
        agency = agency.rows[0];

        if (!agency) {
            // Fetch from Notion and create the agency record
            try {
                const page = await notionService.notion.pages.retrieve({ page_id: formattedId });
                const props = page.properties;

                // Extract title
                const titleProp = Object.values(props).find(p => p.type === 'title');
                const agencyName = titleProp?.title?.[0]?.plain_text || 'Unknown Agency';

                // Extract key fields
                const getText = (name) => {
                    const p = props[name];
                    if (!p) return null;
                    if (p.type === 'rich_text') return p.rich_text?.[0]?.plain_text || null;
                    if (p.type === 'email') return p.email || null;
                    if (p.type === 'phone_number') return p.phone_number || null;
                    if (p.type === 'url') return p.url || null;
                    if (p.type === 'select') return p.select?.name || null;
                    return null;
                };

                // Try common Notion field names for agency data
                const emailFoia = getText('FOIA Email') || getText('Email FOIA') || getText('Records Email') || getText('Email');
                const emailMain = getText('Email Main') || getText('General Email') || emailFoia;
                const portalUrl = getText('Portal URL') || getText('Portal') || getText('Online Portal');
                const state = getText('State');
                const phone = getText('Phone') || getText('Phone Number');

                // Insert into agencies table
                const insertResult = await db.query(`
                    INSERT INTO agencies (notion_page_id, name, state, email_main, email_foia, phone, portal_url, sync_status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 'synced')
                    RETURNING *
                `, [formattedId, agencyName, state, emailMain, emailFoia, phone, portalUrl]);
                agency = insertResult.rows[0];
            } catch (notionErr) {
                return res.status(400).json({ success: false, error: 'Failed to fetch Notion page: ' + notionErr.message });
            }
        }

        // Add as case agency
        const caseAgency = await db.addCaseAgency(caseId, {
            agency_name: agency.name,
            agency_email: agency.email_foia || agency.email_main || null,
            portal_url: agency.portal_url || null,
            portal_provider: agency.portal_provider || null,
            agency_id: agency.id,
            added_source: 'notion_import'
        });

        await db.logActivity('case_agency_added', `Added agency "${agency.name}" from Notion to case ${caseId}`, {
            case_id: caseId,
            case_agency_id: caseAgency.id,
            notion_page_id: formattedId,
            added_source: 'notion_import'
        });

        res.json({ success: true, case_agency: caseAgency, agency });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
