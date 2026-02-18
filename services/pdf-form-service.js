/**
 * PDF Form Service
 *
 * Handles downloading, filling, and creating PDF forms for portal submissions
 * that require a PDF form to be emailed (e.g. Madison County).
 *
 * Flow:
 * 1. Detect PDF-form-related failures from Skyvern
 * 2. Extract PDF URL from failure data
 * 3. Download the PDF
 * 4. Fill form fields (or generate a FOIA letter if not fillable)
 * 5. Save attachment and create proposal for human review
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PDFExtract } = require('pdf.js-extract');
const OpenAI = require('openai');
const database = require('./database');

let _openai;
function getOpenAI() {
    if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _openai;
}

const ATTACHMENTS_DIR = path.join(__dirname, '..', 'data', 'attachments');

// =========================================================================
// Detection
// =========================================================================

/**
 * Check if a Skyvern failure is PDF-form-related.
 */
function isPdfFormFailure(failureReason, workflowResponse) {
    const text = [
        failureReason || '',
        JSON.stringify(workflowResponse || {})
    ].join(' ').toLowerCase();

    return /pdf|download.*form|print.*mail|fillable|fax|cannot be automated within the browser|mail.*form|form.*download|form.*email|submit.*mail|submit.*fax/.test(text);
}

// =========================================================================
// URL Extraction
// =========================================================================

/**
 * Extract a PDF download URL from Skyvern response data.
 * Tries multiple strategies: regex on response, AI extraction, portal URL itself.
 */
async function extractPdfUrl(failureReason, workflowResponse, portalUrl) {
    const responseText = JSON.stringify(workflowResponse || {});

    // Strategy 1: Find .pdf URLs in the response
    const pdfUrlMatch = responseText.match(/https?:\/\/[^\s"',]+\.pdf(?:\?[^\s"',]*)?/i);
    if (pdfUrlMatch) {
        return pdfUrlMatch[0];
    }

    // Strategy 2: Find any download/form URLs
    const downloadMatch = responseText.match(/https?:\/\/[^\s"',]+(?:download|form|request)[^\s"',]*/i);
    if (downloadMatch && /\.pdf|download|form/i.test(downloadMatch[0])) {
        return downloadMatch[0];
    }

    // Strategy 3: Ask AI to extract from the error text
    try {
        const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-5.2',
            messages: [{
                role: 'system',
                content: 'Extract the PDF download URL from this portal failure information. Return ONLY the URL, nothing else. If no URL can be found, return "NONE".'
            }, {
                role: 'user',
                content: `Failure reason: ${failureReason}\n\nPortal URL: ${portalUrl}\n\nResponse data (truncated): ${responseText.substring(0, 3000)}`
            }],
            max_completion_tokens: 200,
            temperature: 0
        });

        const extracted = aiResponse.choices[0]?.message?.content?.trim();
        if (extracted && extracted !== 'NONE' && /^https?:\/\//.test(extracted)) {
            return extracted;
        }
    } catch (err) {
        console.warn('AI PDF URL extraction failed:', err.message);
    }

    // Strategy 4: If portal URL itself ends in .pdf
    if (portalUrl && /\.pdf(\?.*)?$/i.test(portalUrl)) {
        return portalUrl;
    }

    return null;
}

// =========================================================================
// Download
// =========================================================================

/**
 * Download a PDF from a URL and save to disk.
 */
async function downloadPdf(url, caseId) {
    const caseDir = path.join(ATTACHMENTS_DIR, String(caseId));
    fs.mkdirSync(caseDir, { recursive: true });

    const timestamp = Date.now();
    const filename = `form_${timestamp}.pdf`;
    const localPath = path.join(caseDir, filename);

    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    const buffer = Buffer.from(response.data);
    fs.writeFileSync(localPath, buffer);

    console.log(`📄 Downloaded PDF for case ${caseId}: ${localPath} (${buffer.length} bytes)`);
    return { buffer, localPath, filename };
}

// =========================================================================
// Fill PDF
// =========================================================================

/**
 * Build requester info from env vars (mirrors _buildWorkflowPersonalInfo).
 */
function _getRequesterInfo(caseData) {
    return {
        name: process.env.REQUESTER_NAME || 'Samuel Hylton',
        email: process.env.REQUESTER_EMAIL || process.env.REQUESTS_INBOX || 'requests@foib-request.com',
        phone: process.env.REQUESTER_PHONE || '209-800-7702',
        organization: process.env.REQUESTER_ORG || 'Matcher / FOIA Request Team',
        title: process.env.REQUESTER_TITLE || 'Documentary Researcher',
        address: process.env.REQUESTER_ADDRESS || '3021 21st Ave W',
        addressLine2: process.env.REQUESTER_ADDRESS_LINE2 || 'Apt 202',
        city: process.env.REQUESTER_CITY || 'Seattle',
        state: process.env.REQUESTER_STATE || caseData.state || 'WA',
        zip: process.env.REQUESTER_ZIP || '98199'
    };
}

/**
 * Attempt to fill a PDF form. Strategies in order:
 * 1. If fillable fields exist, use AI to map case data to fields
 * 2. If flat form (no fillable fields), use AI to place text overlay on the form pages
 * 3. Last resort: generate a standalone FOIA request letter PDF
 */
async function fillPdfForm(pdfBuffer, caseData) {
    const requester = _getRequesterInfo(caseData);

    let pdfDoc;
    try {
        pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    } catch (loadErr) {
        console.log(`📝 Cannot load PDF (${loadErr.message}), generating FOIA letter`);
        return await _generateFoiaLetterPdf(caseData, requester);
    }

    // Strategy 1: fillable form fields
    try {
        const form = pdfDoc.getForm();
        const fields = form.getFields();
        if (fields.length > 0) {
            return await _fillFormFields(pdfDoc, form, fields, caseData, requester);
        }
    } catch (formErr) {
        // No form or can't parse — continue to flat overlay
    }

    // Strategy 2: AI-driven text overlay on flat form pages
    if (pdfDoc.getPageCount() > 0) {
        try {
            return await _fillFlatForm(pdfDoc, caseData, requester);
        } catch (flatErr) {
            console.warn(`📝 Flat form overlay failed (${flatErr.message}), generating FOIA letter`);
        }
    }

    // Strategy 3: generate standalone letter
    return await _generateFoiaLetterPdf(caseData, requester);
}

/**
 * Post-process AI checkbox placements: ensure the correct option is checked
 * based on preferred_format. Finds checkbox "X" placements near known checkbox
 * labels and moves the X to the correct option.
 */
function _fixCheckboxPlacements(placements, pageLabels, preferredFormat) {
    // Find all "X" placements (checkbox marks)
    const xPlacements = placements.filter(p => String(p.text).trim() === 'X');
    if (xPlacements.length === 0) return placements;

    const isEmailPreferred = /email|electronic/i.test(preferredFormat);
    if (!isEmailPreferred) return placements;

    // Find checkbox-style labels (start with underscores or have checkbox patterns)
    const checkboxLabels = pageLabels.filter(l => /^_{3,}/.test(l.text) || /want.*record|want.*inspect/i.test(l.text));
    if (checkboxLabels.length < 2) return placements; // need at least 2 options to fix

    // Identify the email checkbox vs non-email checkboxes
    const emailCheckbox = checkboxLabels.find(l => /email|emailed|electronic/i.test(l.text));
    const nonEmailCheckboxes = checkboxLabels.filter(l => /photocopy|inspect|digital|fax|print|copy.*record/i.test(l.text) && !/email/i.test(l.text));

    if (!emailCheckbox || nonEmailCheckboxes.length === 0) return placements;

    // Check if any X is near a non-email checkbox (within 8px y tolerance)
    for (const xp of xPlacements) {
        const nearNonEmail = nonEmailCheckboxes.find(l => Math.abs(l.pdfLibY - xp.y) < 8);
        if (nearNonEmail) {
            console.log(`  📌 Fixing checkbox: moving X from y=${xp.y} ("${nearNonEmail.text.substring(0, 40)}...") to email option at y=${emailCheckbox.pdfLibY}`);
            xp.y = emailCheckbox.pdfLibY;
            xp.x = emailCheckbox.x + 2; // Same x as the label start + small offset
        }
    }

    return placements;
}

/**
 * Fill a flat (non-fillable) PDF form by extracting label positions with pdf.js-extract,
 * then using AI to map case data to labels, and overlaying text at precise coordinates.
 */
async function _fillFlatForm(pdfDoc, caseData, requester) {
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pageCount = pdfDoc.getPageCount();

    // Step 1: Extract all text positions from the PDF using pdf.js-extract
    const pdfBytes = await pdfDoc.save();
    const pdfExtract = new PDFExtract();
    const extractData = await pdfExtract.extractBuffer(Buffer.from(pdfBytes), {});

    // Build a structured label map: { pageIndex, label, x, y, width, height }
    const labels = [];
    for (const page of extractData.pages) {
        const pageIdx = page.pageInfo.num - 1; // 0-based
        const pageHeight = page.pageInfo.height;
        for (const item of page.content) {
            if (item.str.trim()) {
                labels.push({
                    pageIndex: pageIdx,
                    pageHeight,
                    text: item.str.trim(),
                    // pdf.js-extract uses top-left origin; convert to bottom-left for pdf-lib
                    // Add baseline correction: drawText uses baseline, not bounding box bottom.
                    // Descenders are ~20% of height, so baseline ≈ bottom + 0.2 * height
                    x: item.x,
                    topY: item.y, // y from top
                    pdfLibY: pageHeight - item.y - item.height + item.height * 0.2, // baseline from bottom
                    width: item.width,
                    height: item.height
                });
            }
        }
    }

    const records = Array.isArray(caseData.requested_records)
        ? caseData.requested_records.join('; ')
        : caseData.requested_records;

    const today = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });

    // Step 2: AI template for per-page form filling
    const aiTemplate = {
        model: 'gpt-5.2',
        messages: [{
            role: 'system',
            content: `You are filling out a PDF government form. You have exact label positions extracted from ONE page of the form.

For each label that needs an answer, return a placement with:
- "x": x coordinate to place the answer text
- "y": y coordinate (pdf-lib bottom-left origin) to place the answer text
- "text": the answer text to place
- "size": font size (default 10, use 9 for long text)

RULES for placing text:
- For labels like "Date of request:", "Requestor's name:", etc., place the answer right after the label: x = label.x + label.width + 4, y = label.pdfLibY
- For City/State/Zip on the same line: place city after "City:" label, state after "State:" label, zip after "Zip:" label
- For labels followed by blank answer lines BELOW (e.g. "Title of requested record"), place text on the next line down: x = label.x, y = label.pdfLibY - label.height - 4
- CHECKBOXES: When you see a group of checkbox options (e.g. "inspect", "emailed", "photocopy", "digital copy"), you MUST select EXACTLY ONE that matches preferred_format. The preferred_format is "email / electronic delivery", so you MUST select the "email" checkbox option. Place "X" at: x = label.x + 2, y = label.pdfLibY. Do NOT mark photocopy, inspect, or any other option.
- Only fill form field areas (skip policy/instruction text, headers, footers)
- Do NOT place text on "(For Internal Use Only)" fields
- Fill ALL relevant fields on this page — do not leave blanks if you have the data

Return JSON with a "placements" array.`
        }, {
            role: 'user',
            content: null // set per-page below
        }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 4000,
        temperature: 0
    };

    const formData = {
        date_of_request: today,
        name: requester.name,
        address: `${requester.address}${requester.addressLine2 ? ', ' + requester.addressLine2 : ''}`,
        city: requester.city,
        state: requester.state,
        zip: requester.zip,
        phone: requester.phone,
        email: requester.email,
        organization: requester.organization,
        records_requested: records,
        subject_name: caseData.subject_name,
        incident_date: caseData.incident_date,
        incident_location: caseData.incident_location,
        agency_name: caseData.agency_name,
        preferred_format: 'email / electronic delivery'
    };

    // Step 3: Per-page AI calls for better coverage
    let totalPlaced = 0;
    const pageGroups = {};
    for (const l of labels) {
        if (!pageGroups[l.pageIndex]) pageGroups[l.pageIndex] = [];
        pageGroups[l.pageIndex].push(l);
    }

    for (const [pageIdxStr, pageLabels] of Object.entries(pageGroups)) {
        const pageIdx = parseInt(pageIdxStr);
        if (pageIdx < 0 || pageIdx >= pageCount) continue;

        // Skip pages with very few labels (likely policy/instruction pages)
        if (pageLabels.length < 5) continue;

        const pageAiResponse = await getOpenAI().chat.completions.create({
            ...aiTemplate,
            messages: [
                aiTemplate.messages[0],
                {
                    role: 'user',
                    content: JSON.stringify({
                        page_number: pageIdx + 1,
                        labels: pageLabels.map(l => ({
                            text: l.text,
                            x: Math.round(l.x * 10) / 10,
                            pdfLibY: Math.round(l.pdfLibY * 10) / 10,
                            width: Math.round(l.width * 10) / 10,
                            height: Math.round(l.height * 10) / 10
                        })),
                        form_data: formData
                    })
                }
            ]
        });

        let result;
        try {
            result = JSON.parse(pageAiResponse.choices[0]?.message?.content || '{}');
        } catch {
            console.warn(`AI returned invalid JSON for page ${pageIdx}, skipping`);
            continue;
        }

        let placements = result.placements || [];

        // Post-process: fix checkbox selections based on preferred_format
        placements = _fixCheckboxPlacements(placements, pageLabels, formData.preferred_format);

        const page = pdfDoc.getPage(pageIdx);
        for (const p of placements) {
            if (p.text && p.x != null && p.y != null) {
                page.drawText(String(p.text), {
                    x: p.x,
                    y: p.y,
                    size: p.size || 10,
                    font,
                    color: rgb(0, 0, 0)
                });
                totalPlaced++;
            }
        }
        console.log(`  Page ${pageIdx + 1}: ${placements.length} placements`);
    }

    const placedCount = totalPlaced;

    console.log(`✅ Placed ${placedCount} text items on flat form (${pageCount} pages) using label-aware positioning`);
    const filledBytes = await pdfDoc.save();
    return Buffer.from(filledBytes);
}

/**
 * Use AI to map case data to form field names, then fill each field.
 */
async function _fillFormFields(pdfDoc, form, fields, caseData, requester) {
    const fieldInfo = fields.map(f => ({
        name: f.getName(),
        type: f.constructor.name
    }));

    console.log(`📋 Found ${fields.length} fillable fields:`, fieldInfo.map(f => f.name).join(', '));

    const aiResponse = await getOpenAI().chat.completions.create({
        model: 'gpt-5.2',
        messages: [{
            role: 'system',
            content: `You are filling out a FOIA/public records request PDF form. Given the form field names and case data, return a JSON object mapping field names to values. Only include fields you can confidently fill. Use exact field names as keys.`
        }, {
            role: 'user',
            content: JSON.stringify({
                form_fields: fieldInfo,
                case_data: {
                    subject_name: caseData.subject_name,
                    case_name: caseData.case_name,
                    agency_name: caseData.agency_name,
                    incident_date: caseData.incident_date,
                    incident_location: caseData.incident_location,
                    requested_records: Array.isArray(caseData.requested_records) ? caseData.requested_records.join('; ') : caseData.requested_records,
                    additional_details: caseData.additional_details,
                    state: caseData.state
                },
                requester_info: requester
            })
        }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 2000,
        temperature: 0
    });

    let fieldMapping;
    try {
        fieldMapping = JSON.parse(aiResponse.choices[0]?.message?.content || '{}');
    } catch {
        fieldMapping = {};
    }

    let filledCount = 0;
    for (const [fieldName, value] of Object.entries(fieldMapping)) {
        try {
            const field = form.getField(fieldName);
            if (!field || !value) continue;

            const typeName = field.constructor.name;
            if (typeName === 'PDFTextField') {
                field.setText(String(value));
                filledCount++;
            } else if (typeName === 'PDFCheckBox') {
                if (value === true || value === 'true' || value === 'Yes') {
                    field.check();
                    filledCount++;
                }
            } else if (typeName === 'PDFDropdown') {
                try { field.select(String(value)); filledCount++; } catch { /* option not available */ }
            } else if (typeName === 'PDFRadioGroup') {
                try { field.select(String(value)); filledCount++; } catch { /* option not available */ }
            }
        } catch (err) {
            console.warn(`Could not fill field "${fieldName}":`, err.message);
        }
    }

    console.log(`✅ Filled ${filledCount}/${fields.length} form fields`);

    const filledBytes = await pdfDoc.save();
    return Buffer.from(filledBytes);
}

/**
 * Generate a standard FOIA request letter PDF when no fillable form is available.
 */
async function _generateFoiaLetterPdf(caseData, requester) {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const page = pdfDoc.addPage([612, 792]); // Letter size
    const { height } = page.getSize();
    const margin = 72; // 1 inch
    const fontSize = 11;
    const lineHeight = 16;
    let y = height - margin;

    function drawText(text, options = {}) {
        const f = options.font || font;
        const size = options.size || fontSize;
        page.drawText(text, {
            x: options.x || margin,
            y,
            size,
            font: f,
            color: rgb(0, 0, 0)
        });
        y -= options.spacing || lineHeight;
    }

    function drawWrappedText(text, maxWidth) {
        if (!text) return;
        if (Array.isArray(text)) text = text.join('; ');
        text = String(text);
        const words = text.split(/\s+/);
        let line = '';
        for (const word of words) {
            const testLine = line ? `${line} ${word}` : word;
            const width = font.widthOfTextAtSize(testLine, fontSize);
            if (width > maxWidth && line) {
                drawText(line);
                line = word;
            } else {
                line = testLine;
            }
        }
        if (line) drawText(line);
    }

    const today = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });

    // Header
    drawText(today);
    y -= lineHeight;

    drawText(caseData.agency_name || 'Records Custodian', { font: boldFont });
    if (caseData.incident_location) drawText(caseData.incident_location);
    y -= lineHeight;

    drawText('RE: Public Records Request', { font: boldFont, size: 13 });
    y -= lineHeight;

    drawText('Dear Records Custodian,');
    y -= lineHeight / 2;

    // Body
    const maxWidth = 612 - 2 * margin;
    drawWrappedText(
        `Pursuant to the ${caseData.state || ''} public records act and/or the Freedom of Information Act, ` +
        `I am requesting copies of the following records:`,
        maxWidth
    );
    y -= lineHeight / 2;

    // Requested records
    const records = caseData.requested_records || caseData.additional_details || 'All records related to the subject';
    drawWrappedText(records, maxWidth);
    y -= lineHeight / 2;

    // Subject info
    if (caseData.subject_name) {
        drawWrappedText(`Subject: ${caseData.subject_name}`, maxWidth);
    }
    if (caseData.incident_date) {
        drawWrappedText(`Date of incident: ${caseData.incident_date}`, maxWidth);
    }
    if (caseData.incident_location) {
        drawWrappedText(`Location: ${caseData.incident_location}`, maxWidth);
    }
    y -= lineHeight / 2;

    drawWrappedText(
        `I am willing to pay reasonable fees for the cost of copying these records. ` +
        `If the fees exceed $25.00, please notify me before proceeding.`,
        maxWidth
    );
    y -= lineHeight / 2;

    drawWrappedText(
        `I request a fee waiver as this request is made for non-commercial, documentary, ` +
        `and public interest purposes.`,
        maxWidth
    );
    y -= lineHeight / 2;

    drawWrappedText(
        `Please provide the records in electronic format if possible. ` +
        `If you have any questions, please contact me at the information below.`,
        maxWidth
    );
    y -= lineHeight;

    drawText('Thank you for your assistance.');
    y -= lineHeight;

    // Signature block
    drawText('Sincerely,');
    y -= lineHeight / 2;
    drawText(requester.name, { font: boldFont });
    if (requester.organization) drawText(requester.organization);
    drawText(requester.address);
    if (requester.addressLine2) drawText(requester.addressLine2);
    drawText(`${requester.city}, ${requester.state} ${requester.zip}`);
    drawText(`Email: ${requester.email}`);
    drawText(`Phone: ${requester.phone}`);

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

// =========================================================================
// Orchestrator
// =========================================================================

/**
 * Main entry point: handle a PDF form fallback when Skyvern can't submit via browser.
 *
 * @returns {{ success: boolean, attachmentId?: number, draftSubject?: string, draftBodyText?: string, pdfPath?: string }}
 */
async function handlePdfFormFallback(caseData, portalUrl, failureReason, workflowResponse) {
    console.log(`📄 Attempting PDF form fallback for case ${caseData.id} (${caseData.case_name})`);

    // 1. Extract PDF URL
    const pdfUrl = await extractPdfUrl(failureReason, workflowResponse, portalUrl);

    let pdfBuffer;
    let localPath;
    let filename;

    if (pdfUrl) {
        // 2. Download PDF
        console.log(`📥 Downloading PDF from: ${pdfUrl}`);
        const downloaded = await downloadPdf(pdfUrl, caseData.id);
        pdfBuffer = downloaded.buffer;
        localPath = downloaded.localPath;
        filename = downloaded.filename;
    } else {
        console.log(`📝 No PDF URL found, generating FOIA letter directly`);
    }

    // 3. Fill PDF form or generate letter
    let filledBuffer;
    if (pdfBuffer) {
        filledBuffer = await fillPdfForm(pdfBuffer, caseData);
    } else {
        // No PDF to download — just generate a letter
        const requester = _getRequesterInfo(caseData);
        filledBuffer = await _generateFoiaLetterPdf(caseData, requester);
    }

    // 4. Save filled PDF to disk
    const caseDir = path.join(ATTACHMENTS_DIR, String(caseData.id));
    fs.mkdirSync(caseDir, { recursive: true });

    const timestamp = Date.now();
    const filledFilename = `filled_${timestamp}.pdf`;
    const filledPath = path.join(caseDir, filledFilename);
    fs.writeFileSync(filledPath, filledBuffer);

    console.log(`💾 Saved filled PDF: ${filledPath} (${filledBuffer.length} bytes)`);

    // 5. Save to attachments table
    const attachment = await database.createAttachment({
        message_id: null,
        case_id: caseData.id,
        filename: filledFilename,
        content_type: 'application/pdf',
        size_bytes: filledBuffer.length,
        storage_path: filledPath
    });

    // 6. Generate cover email draft via AI
    const requester = _getRequesterInfo(caseData);
    const emailDraft = await _generateCoverEmail(caseData, requester, portalUrl);

    console.log(`✅ PDF form fallback complete for case ${caseData.id}`);

    return {
        success: true,
        attachmentId: attachment.id,
        draftSubject: emailDraft.subject,
        draftBodyText: emailDraft.bodyText,
        pdfPath: filledPath,
        pdfUrl
    };
}

/**
 * Generate a cover email to send with the filled PDF form.
 */
async function _generateCoverEmail(caseData, requester, portalUrl) {
    try {
        const aiResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-5.2',
            messages: [{
                role: 'system',
                content: `Write a brief, professional email to submit a FOIA/public records request form via email.
The PDF form is attached. Keep it under 150 words. Include the requester's contact info in a signature block.
Return JSON with "subject" and "bodyText" keys.`
            }, {
                role: 'user',
                content: JSON.stringify({
                    agency_name: caseData.agency_name,
                    subject_name: caseData.subject_name,
                    state: caseData.state,
                    portal_url: portalUrl,
                    requester
                })
            }],
            response_format: { type: 'json_object' },
            max_completion_tokens: 500,
            temperature: 0.3
        });

        const parsed = JSON.parse(aiResponse.choices[0]?.message?.content || '{}');
        return {
            subject: parsed.subject || `Public Records Request - ${caseData.subject_name || caseData.case_name}`,
            bodyText: parsed.bodyText || _defaultCoverEmail(caseData, requester)
        };
    } catch (err) {
        console.warn('AI cover email generation failed, using default:', err.message);
        return {
            subject: `Public Records Request - ${caseData.subject_name || caseData.case_name}`,
            bodyText: _defaultCoverEmail(caseData, requester)
        };
    }
}

function _defaultCoverEmail(caseData, requester) {
    return `Dear Records Custodian,

Please find attached my public records request form for your review and processing.

Subject: ${caseData.subject_name || 'N/A'}
Agency: ${caseData.agency_name || 'N/A'}

I would appreciate electronic delivery of responsive records if possible. Please contact me if you have any questions or require additional information.

Thank you,
${requester.name}
${requester.organization || ''}
${requester.email}
${requester.phone}`.trim();
}

module.exports = {
    isPdfFormFailure,
    extractPdfUrl,
    downloadPdf,
    fillPdfForm,
    handlePdfFormFallback
};
