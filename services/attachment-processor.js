/**
 * Attachment Processor — Extracts text from PDF attachments
 *
 * When an agency sends back a PDF (records, denial letter, fee invoice),
 * this service extracts the text so the classifier and decision engine
 * can see what's inside and act on it.
 *
 * Supported formats:
 *   - PDF (via pdf.js-extract)
 *   - Plain text / HTML (direct read)
 *
 * Unsupported formats are skipped (images, zip, docx, etc.)
 */

const { PDFExtract } = require('pdf.js-extract');
const db = require('./database');

const pdfExtract = new PDFExtract();

// Max text to extract per attachment (prevent DB bloat from huge docs)
const MAX_EXTRACTED_TEXT = 50000;

// Content types we can extract text from
const EXTRACTABLE_TYPES = [
    'application/pdf',
    'text/plain',
    'text/html',
    'text/csv',
];

function isExtractable(contentType) {
    if (!contentType) return false;
    return EXTRACTABLE_TYPES.some(t => contentType.toLowerCase().startsWith(t));
}

/**
 * Extract text from a PDF buffer.
 * Returns the concatenated text from all pages, or null on failure.
 */
async function extractPdfText(buffer) {
    try {
        const data = await pdfExtract.extractBuffer(buffer, {});
        if (!data?.pages?.length) return null;

        const pageTexts = data.pages.map((page, i) => {
            const lines = [];
            let currentY = null;
            let currentLine = '';

            // Sort content items by position (top to bottom, left to right)
            const items = (page.content || []).sort((a, b) => {
                if (Math.abs(a.y - b.y) < 3) return a.x - b.x;
                return a.y - b.y;
            });

            for (const item of items) {
                if (!item.str || !item.str.trim()) continue;

                // New line if Y position changed significantly
                if (currentY !== null && Math.abs(item.y - currentY) > 3) {
                    if (currentLine.trim()) lines.push(currentLine.trim());
                    currentLine = '';
                }
                currentY = item.y;
                currentLine += (currentLine ? ' ' : '') + item.str;
            }
            if (currentLine.trim()) lines.push(currentLine.trim());

            return lines.join('\n');
        });

        const fullText = pageTexts.filter(t => t).join('\n\n--- Page Break ---\n\n');
        return fullText.substring(0, MAX_EXTRACTED_TEXT) || null;
    } catch (err) {
        console.error('PDF text extraction failed:', err.message);
        return null;
    }
}

/**
 * Extract text from a plain text or HTML buffer.
 */
function extractPlainText(buffer, contentType) {
    try {
        let text = buffer.toString('utf-8');

        // Strip HTML tags for text/html
        if (contentType?.includes('html')) {
            text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        return text.substring(0, MAX_EXTRACTED_TEXT) || null;
    } catch (err) {
        return null;
    }
}

/**
 * Process a single attachment: extract text and save to DB.
 *
 * @param {number} attachmentId - DB attachment ID
 * @param {Buffer} buffer - File binary data
 * @param {string} contentType - MIME type
 * @returns {string|null} Extracted text, or null
 */
async function processAttachment(attachmentId, buffer, contentType) {
    if (!buffer || !isExtractable(contentType)) return null;

    let text = null;

    if (contentType?.includes('pdf')) {
        text = await extractPdfText(buffer);
    } else {
        text = extractPlainText(buffer, contentType);
    }

    if (text) {
        await db.query(
            'UPDATE attachments SET extracted_text = $1 WHERE id = $2',
            [text, attachmentId]
        );
    }

    return text;
}

/**
 * Process all unprocessed attachments for a case.
 * Called by the pipeline when it needs attachment text for classification.
 *
 * @param {number} caseId
 * @returns {Array<{id, filename, extracted_text}>}
 */
async function processAttachmentsForCase(caseId) {
    const attachments = await db.getAttachmentsByCaseId(caseId);
    const results = [];

    for (const att of attachments) {
        // Skip if already processed
        if (att.extracted_text) {
            results.push({
                id: att.id,
                filename: att.filename,
                extracted_text: att.extracted_text,
            });
            continue;
        }

        // Skip non-extractable types
        if (!isExtractable(att.content_type)) continue;

        // Get the binary data
        let buffer = null;

        // Try file_data from DB first
        if (!buffer) {
            const fullAtt = await db.getAttachmentById(att.id);
            if (fullAtt?.file_data) buffer = fullAtt.file_data;
        }

        // Try disk
        if (!buffer && att.storage_path) {
            try {
                const fs = require('fs');
                if (fs.existsSync(att.storage_path)) {
                    buffer = fs.readFileSync(att.storage_path);
                }
            } catch (_) {}
        }

        // Try S3/R2
        if (!buffer && att.storage_url) {
            try {
                const storageService = require('./storage-service');
                const key = att.storage_url.replace(/^s3:\/\/[^/]+\//, '');
                buffer = await storageService.download(key);
            } catch (_) {}
        }

        if (!buffer) continue;

        const text = await processAttachment(att.id, buffer, att.content_type);
        if (text) {
            results.push({
                id: att.id,
                filename: att.filename,
                extracted_text: text,
            });
        }
    }

    return results;
}

module.exports = {
    processAttachment,
    processAttachmentsForCase,
    extractPdfText,
    isExtractable,
};
