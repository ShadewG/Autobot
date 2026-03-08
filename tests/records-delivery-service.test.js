const assert = require('assert');

const {
  extractCandidateDownloadUrls,
  buildCaseCompletionReport,
  catalogMessageDelivery,
} = require('../services/records-delivery-service');

describe('records delivery service', function () {
  it('extracts only direct download candidate URLs', function () {
    const urls = extractCandidateDownloadUrls(`
      View portal: https://portal.example.com/request/123
      Download PDF: https://records.example.com/files/report.pdf
      Download zip: https://records.example.com/download?id=55
    `);

    assert.deepStrictEqual(urls, [
      'https://records.example.com/files/report.pdf',
      'https://records.example.com/download?id=55',
    ]);
  });

  it('builds a completion report from requested and received records', async function () {
    const report = await buildCaseCompletionReport(501, {
      caseData: {
        requested_records: ['Incident report', '911 audio'],
      },
      receivedRecords: [
        { id: 1, filename: 'incident-report.pdf', matched_scope_item: 'Incident report', source_type: 'email_attachment', attachment_id: 12, source_url: null },
      ],
      db: {},
    });

    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.outstanding, ['911 audio']);
    assert.strictEqual(report.requested[0].received, true);
    assert.strictEqual(report.requested[1].received, false);
  });

  it('catalogs inbound attachments and flags incomplete partial deliveries', async function () {
    const calls = [];
    const fakeDb = {
      getCaseById: async () => ({ id: 700, case_name: 'Delivery Case', requested_records: ['Incident report', '911 audio'] }),
      getAttachmentsByMessageId: async () => ([
        { id: 41, filename: 'incident-report.pdf', content_type: 'application/pdf', size_bytes: 1024, extracted_text: 'Incident report narrative' },
      ]),
      getReceivedRecordByAttachmentId: async () => null,
      getReceivedRecordBySourceUrl: async () => null,
      createReceivedRecord: async (payload) => {
        calls.push(['createReceivedRecord', payload]);
        return { id: 1, ...payload };
      },
      getReceivedRecordsByCaseId: async () => ([
        { id: 1, filename: 'incident-report.pdf', matched_scope_item: 'Incident report', source_type: 'email_attachment', attachment_id: 41, source_url: null },
      ]),
      logActivity: async (type, description, metadata) => calls.push(['logActivity', type, description, metadata]),
    };

    const result = await catalogMessageDelivery({
      caseId: 700,
      messageId: 88,
      classification: 'PARTIAL_DELIVERY',
      bodyText: 'See attached incident report.',
      db: fakeDb,
      fetchImpl: async () => { throw new Error('should not fetch direct links here'); },
    });

    assert.strictEqual(result.cataloged, 1);
    assert.strictEqual(result.downloaded, 0);
    assert.strictEqual(result.flaggedIncomplete, true);
    assert.deepStrictEqual(result.report.outstanding, ['911 audio']);
    assert.ok(calls.some((entry) => entry[0] === 'createReceivedRecord'));
    assert.ok(calls.some((entry) => entry[0] === 'logActivity' && entry[1] === 'delivery_incomplete_flagged'));
  });

  it('downloads direct delivery links and catalogs them as received records', async function () {
    const calls = [];
    const fakeDb = {
      getCaseById: async () => ({ id: 701, case_name: 'Download Case', requested_records: ['Body camera footage'] }),
      getAttachmentsByMessageId: async () => ([]),
      getReceivedRecordByAttachmentId: async () => null,
      getReceivedRecordBySourceUrl: async () => null,
      createAttachment: async (payload) => {
        calls.push(['createAttachment', payload]);
        return { id: 52, ...payload };
      },
      createReceivedRecord: async (payload) => {
        calls.push(['createReceivedRecord', payload]);
        return { id: 2, ...payload };
      },
      getReceivedRecordsByCaseId: async () => ([
        { id: 2, filename: 'video.mp4', matched_scope_item: 'Body camera footage', source_type: 'portal_download_link', attachment_id: 52, source_url: 'https://records.example.com/video.mp4' },
      ]),
      logActivity: async (type, description, metadata) => calls.push(['logActivity', type, description, metadata]),
    };

    const result = await catalogMessageDelivery({
      caseId: 701,
      messageId: 89,
      classification: 'RECORDS_READY',
      bodyText: 'Download the responsive file here: https://records.example.com/video.mp4',
      db: fakeDb,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'video/mp4' : null) },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      }),
    });

    assert.strictEqual(result.cataloged, 1);
    assert.strictEqual(result.downloaded, 1);
    assert.strictEqual(result.report.complete, true);
    assert.ok(calls.some((entry) => entry[0] === 'createAttachment' && entry[1].storage_url === 'https://records.example.com/video.mp4'));
  });
});
