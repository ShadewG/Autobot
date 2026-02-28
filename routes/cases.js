/**
 * Cases Routes
 *
 * Routes for creating and managing cases.
 *
 * Routes:
 * - POST /cases/import-notion - Import a case from a Notion page URL
 * - POST /cases/import-direct - Import a case directly from FOIA Researcher
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../services/database');
const notionService = require('../services/notion-service');
const logger = require('../services/logger');

/**
 * Extract Notion page ID from various URL formats
 *
 * Supports:
 * - https://www.notion.so/workspace/Page-Title-abc123def456...
 * - https://www.notion.so/abc123def456...
 * - https://notion.so/Page-Title-abc123def456...
 * - Just the page ID: abc123def456...
 */
function extractNotionPageId(input) {
  if (!input) return null;

  // Clean up input
  const trimmed = input.trim();

  // If it looks like a raw page ID (32 hex chars with optional hyphens)
  const idPattern = /^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$/i;
  if (idPattern.test(trimmed.replace(/-/g, '').substring(0, 32))) {
    return trimmed.replace(/-/g, '').substring(0, 32);
  }

  // Try to extract from URL
  try {
    const url = new URL(trimmed);

    // Get the path after notion.so
    const pathParts = url.pathname.split('/').filter(p => p);

    if (pathParts.length === 0) return null;

    // The page ID is typically the last 32 characters of the last path segment
    // (after removing hyphens)
    const lastPart = pathParts[pathParts.length - 1];

    // Try to find a 32-char hex string at the end
    // Format: Page-Title-abc123def456...
    const match = lastPart.match(/([a-f0-9]{32})$/i);
    if (match) {
      return match[1];
    }

    // Try hyphenated format: abc123-def4-5678-9abc-def012345678
    const hyphenatedMatch = lastPart.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
    if (hyphenatedMatch) {
      return hyphenatedMatch[1].replace(/-/g, '');
    }

    // Last resort: take the last segment and check if it's mostly hex
    const cleaned = lastPart.replace(/[^a-f0-9]/gi, '');
    if (cleaned.length >= 32) {
      return cleaned.substring(cleaned.length - 32);
    }

    return null;
  } catch (e) {
    // Not a valid URL, try to extract ID directly
    const cleaned = trimmed.replace(/[^a-f0-9]/gi, '');
    if (cleaned.length >= 32) {
      return cleaned.substring(0, 32);
    }
    return null;
  }
}

/**
 * POST /cases/import-notion
 *
 * Import a case from a Notion page URL.
 *
 * Body:
 * - notion_url: (required) URL or page ID of the Notion page
 *
 * Returns the created case.
 */
router.post('/import-notion', async (req, res) => {
  const { notion_url, refresh_existing = true } = req.body || {};

  try {
    // Validate input
    if (!notion_url) {
      return res.status(400).json({
        success: false,
        error: 'notion_url is required'
      });
    }

    // Extract page ID
    const pageId = extractNotionPageId(notion_url);
    if (!pageId) {
      return res.status(400).json({
        success: false,
        error: 'Could not extract Notion page ID from URL',
        hint: 'Please provide a valid Notion page URL (e.g., https://www.notion.so/workspace/Page-Title-abc123...)'
      });
    }

    logger.info('Importing case from Notion', { pageId, notion_url });

    // Check if case already exists
    const existing = await db.getCaseByNotionId(pageId);
    if (existing) {
      let effectiveCase = existing;

      // Re-sync existing case from Notion so recently added portal/email fields are picked up.
      if (refresh_existing) {
        const freshCase = await notionService.fetchPageById(pageId);
        const updates = {
          case_name: freshCase.case_name || existing.case_name,
          subject_name: freshCase.subject_name || existing.subject_name,
          agency_name: freshCase.agency_name || existing.agency_name,
          agency_email: freshCase.agency_email || existing.agency_email,
          alternate_agency_email: freshCase.alternate_agency_email || existing.alternate_agency_email,
          state: freshCase.state || existing.state,
          incident_date: freshCase.incident_date || existing.incident_date,
          incident_location: freshCase.incident_location || existing.incident_location,
          requested_records: freshCase.requested_records || existing.requested_records,
          additional_details: freshCase.additional_details || existing.additional_details,
          portal_url: freshCase.portal_url || existing.portal_url,
          portal_provider: freshCase.portal_provider || existing.portal_provider
        };
        effectiveCase = await db.updateCase(existing.id, updates);
      }

      return res.json({
        success: true,
        message: refresh_existing ? 'Case already exists (re-synced from Notion)' : 'Case already exists',
        case_id: effectiveCase.id,
        case: {
          id: effectiveCase.id,
          case_name: effectiveCase.case_name,
          subject_name: effectiveCase.subject_name,
          agency_name: effectiveCase.agency_name,
          agency_email: effectiveCase.agency_email,
          status: effectiveCase.status,
          portal_url: effectiveCase.portal_url,
          portal_provider: effectiveCase.portal_provider
        }
      });
    }

    // Import from Notion
    const newCase = await notionService.processSinglePage(pageId);

    if (!newCase) {
      return res.status(500).json({
        success: false,
        error: 'Failed to import case from Notion'
      });
    }

    logger.info('Case imported from Notion', {
      caseId: newCase.id,
      caseName: newCase.case_name,
      agencyName: newCase.agency_name
    });

    res.status(201).json({
      success: true,
      message: 'Case imported successfully',
      case_id: newCase.id,
      case: {
        id: newCase.id,
        case_name: newCase.case_name,
        subject_name: newCase.subject_name,
        agency_name: newCase.agency_name,
        agency_email: newCase.agency_email,
        state: newCase.state,
        status: newCase.status,
        portal_url: newCase.portal_url
      }
    });

  } catch (error) {
    logger.error('Error importing case from Notion', { error: error.message, notion_url });

    // Handle specific Notion API errors
    if (error.code === 'object_not_found') {
      return res.status(404).json({
        success: false,
        error: 'Notion page not found',
        hint: 'Make sure the page exists and the Notion integration has access to it'
      });
    }

    if (error.code === 'unauthorized') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to access this Notion page',
        hint: 'Make sure the Notion integration is connected to the workspace containing this page'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /cases/import-direct
 *
 * Import a case directly from FOIA Researcher (or any service with a valid service key).
 * Creates one case with the primary agency, then adds remaining agencies via case_agencies.
 *
 * Auth: X-Service-Key header checked against FOIA_SERVICE_KEY env var.
 *
 * Body: { source, source_article_id, source_article_url, case_name, subject_name,
 *         incident_date, incident_location, state, additional_details,
 *         requests: [{ agency_name, agency_email, portal_url, portal_provider,
 *                      requested_records, involvement_summary }] }
 */
router.post('/import-direct', async (req, res) => {
  // --- Auth: constant-time comparison against FOIA_SERVICE_KEY ---
  const serviceKey = process.env.FOIA_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(503).json({ success: false, error: 'Service key not configured' });
  }
  const provided = req.headers['x-service-key'] || '';
  try {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(serviceKey);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ success: false, error: 'Invalid service key' });
    }
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid service key' });
  }

  const {
    source = 'foia_researcher',
    source_article_id,
    source_article_url,
    case_name,
    subject_name,
    incident_date,
    incident_location,
    state,
    additional_details,
    requests = [],
  } = req.body || {};

  // --- Validation ---
  if (!case_name) return res.status(400).json({ success: false, error: 'case_name is required' });
  if (!subject_name) return res.status(400).json({ success: false, error: 'subject_name is required' });
  if (!requests.length) return res.status(400).json({ success: false, error: 'At least one request/agency is required' });

  try {
    // Normalize state to 2-letter uppercase
    const normalizedState = state ? state.trim().toUpperCase().slice(0, 2) : null;

    // Parse incident_date to ISO YYYY-MM-DD
    let parsedDate = null;
    if (incident_date) {
      const d = new Date(incident_date);
      if (!isNaN(d.getTime())) parsedDate = d.toISOString().split('T')[0];
    }

    // Synthetic notion_page_id for dedup: one case per source article
    const syntheticId = source_article_id ? `foia-${source_article_id}` : null;

    // --- Dedup check ---
    if (syntheticId) {
      const existing = await db.getCaseByNotionId(syntheticId);
      if (existing) {
        return res.json({
          success: true,
          message: 'Case already exists (dedup)',
          case_id: existing.id,
          case_name: existing.case_name,
          agencies_added: 0,
          agencies_skipped: 0,
          agencies: [],
          skipped: [],
        });
      }
    }

    // Partition agencies: usable (have email or portal) vs skipped
    const usable = [];
    const skipped = [];
    for (const r of requests) {
      if (!r.agency_name) continue;
      if (!r.agency_email && !r.portal_url) {
        skipped.push({ agency_name: r.agency_name, reason: 'no_contact_info' });
      } else {
        usable.push(r);
      }
    }

    if (usable.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No agencies with contact info (email or portal)',
        skipped,
      });
    }

    // Primary agency = first usable
    const primary = usable[0];
    const recordsText = Array.isArray(primary.requested_records)
      ? primary.requested_records.join(', ')
      : primary.requested_records || null;

    const newCase = await db.createCase({
      notion_page_id: syntheticId,
      case_name,
      subject_name,
      agency_name: primary.agency_name,
      agency_email: primary.agency_email || null,
      state: normalizedState,
      incident_date: parsedDate,
      incident_location: incident_location || null,
      requested_records: recordsText,
      additional_details: [
        additional_details,
        source_article_url ? `Source: ${source_article_url}` : null,
        primary.involvement_summary ? `Primary agency role: ${primary.involvement_summary}` : null,
      ].filter(Boolean).join('\n'),
      status: 'ready_to_send',
      portal_url: primary.portal_url || null,
      portal_provider: primary.portal_provider || null,
      tags: source_article_id ? [`source:${source}`] : [],
    });

    // Add primary to case_agencies
    const agencies = [];
    const primaryAgency = await db.addCaseAgency(newCase.id, {
      agency_name: primary.agency_name,
      agency_email: primary.agency_email || null,
      portal_url: primary.portal_url || null,
      portal_provider: primary.portal_provider || null,
      is_primary: true,
      added_source: source,
      status: 'pending',
      notes: primary.involvement_summary || null,
    });
    agencies.push({ agency_name: primary.agency_name, is_primary: true, status: 'pending', id: primaryAgency.id });

    // Add remaining usable agencies
    for (let i = 1; i < usable.length; i++) {
      const r = usable[i];
      const ca = await db.addCaseAgency(newCase.id, {
        agency_name: r.agency_name,
        agency_email: r.agency_email || null,
        portal_url: r.portal_url || null,
        portal_provider: r.portal_provider || null,
        is_primary: false,
        added_source: source,
        status: 'pending',
        notes: r.involvement_summary || null,
      });
      agencies.push({ agency_name: r.agency_name, is_primary: false, status: 'pending', id: ca.id });
    }

    await db.logActivity('case_imported_direct', `Imported case "${case_name}" from ${source}`, {
      case_id: newCase.id,
      source,
      source_article_id,
      agencies_added: agencies.length,
      agencies_skipped: skipped.length,
    });

    logger.info('Case imported directly', {
      caseId: newCase.id,
      caseName: case_name,
      source,
      agenciesAdded: agencies.length,
      agenciesSkipped: skipped.length,
    });

    res.status(201).json({
      success: true,
      case_id: newCase.id,
      case_name: newCase.case_name,
      agencies_added: agencies.length,
      agencies_skipped: skipped.length,
      agencies,
      skipped,
    });

  } catch (error) {
    logger.error('Error importing case directly', { error: error.message, source, case_name });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /cases/by-notion/:pageId
 *
 * Look up a case by Notion page ID. Returns { success, case_id } so the
 * Researcher frontend can poll until the webhook-created case exists.
 * Tries both hyphenated and stripped ID formats.
 */
router.get('/by-notion/:pageId', async (req, res) => {
  try {
    const raw = req.params.pageId.replace(/-/g, '');
    const hyphenated = raw.length === 32
      ? `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`
      : raw;

    let existing = await db.getCaseByNotionId(hyphenated);
    if (!existing) existing = await db.getCaseByNotionId(raw);

    if (existing) {
      return res.json({ success: true, case_id: existing.id });
    }
    res.json({ success: false });
  } catch (error) {
    logger.error('Error looking up case by Notion ID', { pageId: req.params.pageId, error: error.message });
    res.json({ success: false });
  }
});

/**
 * GET /cases/:id
 *
 * Get a case by ID.
 */
router.get('/:id', async (req, res) => {
  const caseId = parseInt(req.params.id);

  try {
    const caseData = await db.getCaseById(caseId);
    if (!caseData) {
      return res.status(404).json({
        success: false,
        error: `Case ${caseId} not found`
      });
    }

    res.json({
      success: true,
      case: caseData
    });

  } catch (error) {
    logger.error('Error fetching case', { caseId, error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
