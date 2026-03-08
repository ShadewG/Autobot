const assert = require('assert');
const sinon = require('sinon');

const attachmentProcessor = require('../services/attachment-processor');

describe('Attachment processor OCR fallback', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('keeps direct PDF text when extraction is already sufficient', async function () {
    const renderStub = sinon.stub().throws(new Error('should not render pages'));
    const imageOcrStub = sinon.stub().throws(new Error('should not OCR images'));

    const result = await attachmentProcessor.extractPdfTextWithFallback(Buffer.from('pdf'), {
      extractPdfTextImpl: sinon.stub().resolves('This PDF already has enough machine-readable text to skip OCR fallback because it contains a full paragraph of searchable content that clearly exceeds the fallback threshold.'),
      renderPdfPagesImpl: renderStub,
      extractImageTextImpl: imageOcrStub,
    });

    assert.strictEqual(result, 'This PDF already has enough machine-readable text to skip OCR fallback because it contains a full paragraph of searchable content that clearly exceeds the fallback threshold.');
    assert.strictEqual(renderStub.called, false);
    assert.strictEqual(imageOcrStub.called, false);
  });

  it('uses OCR fallback for thin scanned PDFs', async function () {
    const renderStub = sinon.stub().resolves([
      { imageBuffer: Buffer.from('page-1'), contentType: 'image/png' },
      { imageBuffer: Buffer.from('page-2'), contentType: 'image/png' },
    ]);
    const imageOcrStub = sinon.stub();
    imageOcrStub.onCall(0).resolves('Scanned letter page one');
    imageOcrStub.onCall(1).resolves('Scanned letter page two');

    const result = await attachmentProcessor.extractPdfTextWithFallback(Buffer.from('pdf'), {
      extractPdfTextImpl: sinon.stub().resolves('too short'),
      renderPdfPagesImpl: renderStub,
      extractImageTextImpl: imageOcrStub,
    });

    assert.strictEqual(renderStub.calledOnce, true);
    assert.strictEqual(imageOcrStub.callCount, 2);
    assert.match(result, /Scanned letter page one/);
    assert.match(result, /Scanned letter page two/);
  });
});
