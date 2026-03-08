const { PDFExtract } = require('pdf.js-extract');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
    const pdfBuffer = fs.readFileSync('./data/attachments/25159/form_1771428253502.pdf');
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pdfBytes = await pdfDoc.save();
    const pdfExtract = new PDFExtract();
    const extractData = await pdfExtract.extractBuffer(Buffer.from(pdfBytes), {});

    // Page 6 (index 5) - look for checkbox-related labels
    const page = extractData.pages[5];
    const pageHeight = page.pageInfo.height;
    console.log('Page 6 labels with checkbox-related keywords:');
    for (const item of page.content) {
        const txt = item.str.trim();
        if (txt.length === 0) continue;
        if (/email|photocopy|inspect|digital|record format|want|_____/i.test(txt)) {
            const pdfLibY = pageHeight - item.y - item.height;
            console.log(JSON.stringify({
                text: txt,
                x: Math.round(item.x * 10) / 10,
                pdfLibY: Math.round(pdfLibY * 10) / 10,
                width: Math.round(item.width * 10) / 10,
                height: Math.round(item.height * 10) / 10
            }));
        }
    }
})().catch(e => { console.error(e); process.exit(1); });
