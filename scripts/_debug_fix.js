const { PDFExtract } = require('pdf.js-extract');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const OpenAI = require('openai');
const fs = require('fs');

(async () => {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const pdfBuffer = fs.readFileSync('./data/attachments/25159/form_1771428253502.pdf');
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pdfBytes = await pdfDoc.save();
    const pdfExtract = new PDFExtract();
    const extractData = await pdfExtract.extractBuffer(Buffer.from(pdfBytes), {});

    const page = extractData.pages[5]; // page 6
    const pageHeight = page.pageInfo.height;

    const pageLabels = [];
    for (const item of page.content) {
        const txt = item.str.trim();
        if (txt.length === 0) continue;
        pageLabels.push({
            text: txt,
            x: item.x,
            pdfLibY: pageHeight - item.y - item.height,
            width: item.width,
            height: item.height
        });
    }

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const formData = {
        date_of_request: today,
        name: 'Samuel Hylton',
        address: '3021 21st Ave W, Apt 202',
        city: 'Seattle',
        state: 'NC',
        zip: '98199',
        phone: '209-800-7702',
        email: 'requests@foib-request.com',
        organization: 'Dr Insanity / FOIA Request Team',
        records_requested: 'arrest records; incident reports; booking records',
        subject_name: 'Paula Plemmons Garrett',
        incident_date: '2025-01-15',
        incident_location: 'Madison County, NC',
        agency_name: "Madison County Sheriff's Office",
        preferred_format: 'email / electronic delivery'
    };

    // Use same prompt as production
    const aiResponse = await openai.chat.completions.create({
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
            content: JSON.stringify({
                page_number: 6,
                labels: pageLabels.map(l => ({
                    text: l.text,
                    x: Math.round(l.x * 10) / 10,
                    pdfLibY: Math.round(l.pdfLibY * 10) / 10,
                    width: Math.round(l.width * 10) / 10,
                    height: Math.round(l.height * 10) / 10
                })),
                form_data: formData
            })
        }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 4000,
        temperature: 0
    });

    const result = JSON.parse(aiResponse.choices[0].message.content);
    const placements = result.placements || [];

    console.log('\n=== ALL PLACEMENTS ===');
    for (const p of placements) {
        console.log(`  text="${p.text}" x=${p.x} y=${p.y} size=${p.size || 10}`);
    }

    // Now check the fix logic
    const xPlacements = placements.filter(p => String(p.text).trim() === 'X');
    console.log('\n=== X PLACEMENTS ===');
    console.log(JSON.stringify(xPlacements, null, 2));

    // Find checkbox labels
    const checkboxLabels = pageLabels.filter(l => /^_{3,}/.test(l.text));
    console.log('\n=== CHECKBOX LABELS ===');
    for (const l of checkboxLabels) {
        console.log(`  pdfLibY=${Math.round(l.pdfLibY*10)/10} text="${l.text.substring(0, 60)}"`);
    }

    // Check proximity
    if (xPlacements.length > 0) {
        for (const xp of xPlacements) {
            for (const l of checkboxLabels) {
                const dist = Math.abs(l.pdfLibY - xp.y);
                console.log(`  Distance from X(y=${xp.y}) to "${l.text.substring(6, 30)}...": ${dist.toFixed(1)}px`);
            }
        }
    }
})().catch(e => { console.error(e); process.exit(1); });
