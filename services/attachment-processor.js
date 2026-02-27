/**
 * Attachment Processor — Extracts text from inbound attachments
 *
 * When an agency sends back a PDF (records, denial letter, fee invoice),
 * this service extracts the text so the classifier and decision engine
 * can see what's inside and act on it.
 *
 * Supported formats:
 *   - PDF (via pdf.js-extract)
 *   - Plain text / HTML / CSV (direct read)
 *   - DOCX (XML unzip extraction)
 *   - Images (OCR via OpenAI vision, if OPENAI_API_KEY is present)
 */

const { PDFExtract } = require('pdf.js-extract');
const OpenAI = require('openai');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('./database');

const pdfExtract = new PDFExtract();
const execFileAsync = promisify(execFile);
const openai = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45_000 })
    : null;

// Max text to extract per attachment (prevent DB bloat from huge docs)
const MAX_EXTRACTED_TEXT = 50000;
const MAX_OCR_IMAGE_BYTES = parseInt(process.env.MAX_OCR_IMAGE_BYTES || `${8 * 1024 * 1024}`, 10);
const OCR_MODEL = process.env.ATTACHMENT_OCR_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// Content types we can extract text from
const EXTRACTABLE_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/html',
    'text/csv',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/heic',
    'image/heif',
];

function isDocx(contentType = '', filename = '') {
    const ct = contentType.toLowerCase();
    const fn = (filename || '').toLowerCase();
    return ct.includes('officedocument.wordprocessingml.document') || fn.endsWith('.docx');
}

function isImage(contentType = '', filename = '') {
    const ct = contentType.toLowerCase();
    const fn = (filename || '').toLowerCase();
    return ct.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(fn);
}

function isExtractable(contentType = '', filename = '') {
    if (isDocx(contentType, filename) || isImage(contentType, filename)) return true;
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

function decodeDocxXml(xml) {
    if (!xml) return '';
    return xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<w:br\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

async function extractDocxText(buffer) {
    // Prefer shell unzip to avoid adding new heavy dependencies.
    let tmpFile = null;
    try {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'autobot-docx-'));
        tmpFile = path.join(dir, 'input.docx');
        await fsp.writeFile(tmpFile, buffer);

        const candidates = [
            'word/document.xml',
            'word/header1.xml',
            'word/header2.xml',
            'word/footer1.xml',
            'word/footer2.xml',
        ];

        const chunks = [];
        for (const entry of candidates) {
            try {
                const { stdout } = await execFileAsync('unzip', ['-p', tmpFile, entry], { maxBuffer: 10 * 1024 * 1024 });
                if (stdout && stdout.trim()) {
                    const text = decodeDocxXml(stdout);
                    if (text) chunks.push(text);
                }
            } catch (_) {
                // Entry may not exist; ignore.
            }
        }

        const full = chunks.join('\n\n').trim();
        return full ? full.substring(0, MAX_EXTRACTED_TEXT) : null;
    } catch (err) {
        console.error('DOCX text extraction failed:', err.message);
        return null;
    } finally {
        if (tmpFile) {
            try {
                await fsp.rm(path.dirname(tmpFile), { recursive: true, force: true });
            } catch (_) {}
        }
    }
}

async function extractImageTextWithOCR(buffer, contentType) {
    if (!openai) return null;
    if (!buffer || buffer.length > MAX_OCR_IMAGE_BYTES) return null;
    try {
        const mime = contentType && contentType.startsWith('image/') ? contentType : 'image/png';
        const imageDataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
        const response = await openai.responses.create({
            model: OCR_MODEL,
            input: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Extract all readable text from this document image. Return plain text only, preserving numbers, dates, and currency amounts when present.',
                        },
                        {
                            type: 'input_image',
                            image_url: imageDataUrl,
                        },
                    ],
                },
            ],
        });
        const text = (response.output_text || '').trim();
        return text ? text.substring(0, MAX_EXTRACTED_TEXT) : null;
    } catch (err) {
        console.error('Image OCR failed:', err.message);
        return null;
    }
}

/**
 * Process a single attachment: extract text and save to DB.
 *
 * @param {number} attachmentId - DB attachment ID
 * @param {Buffer} buffer - File binary data
 * @param {string} contentType - MIME type
 * @param {string} filename - original filename
 * @returns {string|null} Extracted text, or null
 */
async function processAttachment(attachmentId, buffer, contentType, filename = '') {
    if (!buffer || !isExtractable(contentType, filename)) return null;

    let text = null;

    if (contentType?.includes('pdf')) {
        text = await extractPdfText(buffer);
    } else if (isDocx(contentType, filename)) {
        text = await extractDocxText(buffer);
    } else if (isImage(contentType, filename)) {
        text = await extractImageTextWithOCR(buffer, contentType);
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
        if (!isExtractable(att.content_type, att.filename)) continue;

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

        const text = await processAttachment(att.id, buffer, att.content_type, att.filename);
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
    extractDocxText,
    extractImageTextWithOCR,
    isExtractable,
};
