/**
 * Cases Routes
 *
 * Routes for creating and managing cases.
 *
 * Routes:
 * - POST /cases/import-notion - Import a case from a Notion page URL
 */

const express = require('express');
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
  const { notion_url } = req.body || {};

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
      return res.json({
        success: true,
        message: 'Case already exists',
        case_id: existing.id,
        case: {
          id: existing.id,
          case_name: existing.case_name,
          agency_name: existing.agency_name,
          status: existing.status
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
