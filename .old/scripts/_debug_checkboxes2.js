const { PDFExtract } = require('pdf.js-extract');
const { PDFDocument } = require('pdf-lib');
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

    // Call the same AI to see its placements
    const aiResponse = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [{
            role: 'system',
            content: 'You are filling out a PDF government form. Return JSON with a "placements" array. For each placement: {x, y, text, size}. Place "X" for the email checkbox option. preferred_format is "email / electronic delivery".'
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
                form_data: {
                    date_of_request: 'February 18, 2026',
                    name: 'Samuel Hylton',
                    preferred_format: 'email / electronic delivery'
                }
            })
        }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 4000,
        temperature: 0
    });

    const result = JSON.parse(aiResponse.choices[0].message.content);
    const xPlacements = (result.placements || []).filter(p => String(p.text).trim() === 'X');
    console.log('X placements from AI:', JSON.stringify(xPlacements, null, 2));

    // Show the checkbox labels for comparison
    const checkboxLabels = pageLabels.filter(l => /email|photocopy|inspect|digital/i.test(l.text) && l.text.includes('_____'));
    console.log('\nCheckbox labels:');
    for (const l of checkboxLabels) {
        console.log(`  y=${Math.round(l.pdfLibY * 10) / 10}: ${l.text.substring(0, 60)}`);
    }
})().catch(e => { console.error(e); process.exit(1); });
