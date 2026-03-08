const path = require('path');
const db = require('./database');
const logger = require('./logger');

const DIRECT_DOWNLOAD_PATTERNS = [
  /\.(pdf|zip|mp3|wav|mp4|mov|csv|xlsx?|docx?)($|[?#])/i,
  /[?&](download|dl|export)=/i,
  /\/download(\/|$|\?)/i,
];

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getRequestedScopeItems(caseData = {}) {
  if (Array.isArray(caseData.scope_items_jsonb) && caseData.scope_items_jsonb.length > 0) {
    return caseData.scope_items_jsonb
      .map((item) => item?.name || item?.description || item?.label || null)
      .filter(Boolean);
  }
  if (Array.isArray(caseData.requested_records)) return caseData.requested_records.filter(Boolean);
  if (caseData.requested_records) return [caseData.requested_records];
  return [];
}

function extractCandidateDownloadUrls(bodyText = '') {
  const matches = String(bodyText || '').match(/https?:\/\/[^\s<>")']+/gi) || [];
  return Array.from(new Set(matches.filter((url) => DIRECT_DOWNLOAD_PATTERNS.some((pattern) => pattern.test(url)))));
}

function matchScopeItem(caseData, artifact = {}) {
  const scopeItems = getRequestedScopeItems(caseData);
  if (scopeItems.length === 0) return { matchedScopeItem: null, matchConfidence: 0 };

  const haystack = normalizeText([
    artifact.filename,
    artifact.content_type,
    artifact.extracted_text,
    artifact.notes,
  ].filter(Boolean).join(' '));

  for (const scopeItem of scopeItems) {
    const normalizedScope = normalizeText(scopeItem);
    if (!normalizedScope) continue;
    const keywords = normalizedScope.split(' ').filter((part) => part.length >= 3);
    const matchedKeywords = keywords.filter((keyword) => haystack.includes(keyword));
    if (matchedKeywords.length === 0) continue;
    const score = matchedKeywords.length / Math.max(keywords.length, 1);
    if (score >= 0.5 || haystack.includes(normalizedScope)) {
      return {
        matchedScopeItem: scopeItem,
        matchConfidence: Number(Math.min(0.99, Math.max(score, 0.6)).toFixed(3)),
      };
    }
  }

  return { matchedScopeItem: null, matchConfidence: 0 };
}

function buildFilenameFromUrl(url, contentType = null) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || '';
    const base = path.basename(pathname) || 'download';
    if (base && base !== '/') return base;
  } catch (_) {}

  if (String(contentType || '').includes('pdf')) return 'download.pdf';
  if (String(contentType || '').includes('zip')) return 'download.zip';
  return 'download.bin';
}

async function buildCaseCompletionReport(caseId, deps = {}) {
  const database = deps.db || db;
  const caseData = deps.caseData || await database.getCaseById(caseId);
  const receivedRecords = deps.receivedRecords || await database.getReceivedRecordsByCaseId(caseId);
  const requestedItems = getRequestedScopeItems(caseData);

  const requested = requestedItems.map((item) => {
    const delivered = receivedRecords.filter((record) => record.matched_scope_item === item);
    return {
      requested_item: item,
      received: delivered.length > 0,
      received_count: delivered.length,
      received_records: delivered.map((record) => ({
        id: record.id,
        filename: record.filename,
        source_type: record.source_type,
        attachment_id: record.attachment_id,
        source_url: record.source_url,
      })),
    };
  });

  const unmatched = receivedRecords
    .filter((record) => !record.matched_scope_item)
    .map((record) => ({
      id: record.id,
      filename: record.filename,
      source_type: record.source_type,
      attachment_id: record.attachment_id,
      source_url: record.source_url,
    }));

  return {
    case_id: caseId,
    requested,
    unmatched,
    complete: requested.length > 0 && requested.every((item) => item.received),
    outstanding: requested.filter((item) => !item.received).map((item) => item.requested_item),
    received_count: receivedRecords.length,
  };
}

async function maybeDownloadDirectArtifact({ caseData, messageId, url, fetchImpl, database }) {
  if (await database.getReceivedRecordBySourceUrl(caseData.id, url)) {
    return { skipped: true, reason: 'already_cataloged' };
  }

  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  if (/text\/html/i.test(contentType)) {
    return { skipped: true, reason: 'html_page' };
  }

  const arrayBuffer = await response.arrayBuffer();
  const fileData = Buffer.from(arrayBuffer);
  const filename = buildFilenameFromUrl(url, contentType);
  const attachment = await database.createAttachment({
    message_id: messageId,
    case_id: caseData.id,
    filename,
    content_type: contentType,
    size_bytes: fileData.length,
    storage_path: null,
    storage_url: url,
    file_data: fileData,
  });

  return { attachment, downloaded: true };
}

async function catalogMessageDelivery({ caseId, messageId, classification, bodyText = '', fetchImpl = fetch, db: database = db } = {}) {
  if (!['RECORDS_READY', 'PARTIAL_DELIVERY'].includes(String(classification || ''))) {
    return { cataloged: 0, downloaded: 0, flaggedIncomplete: false, report: await buildCaseCompletionReport(caseId, { db: database }) };
  }

  const caseData = await database.getCaseById(caseId);
  const attachments = await database.getAttachmentsByMessageId(messageId);
  let cataloged = 0;
  let downloaded = 0;

  for (const attachment of attachments) {
    const { matchedScopeItem, matchConfidence } = matchScopeItem(caseData, attachment);
    const existing = await database.getReceivedRecordByAttachmentId(attachment.id);
    if (existing) continue;
    await database.createReceivedRecord({
      case_id: caseId,
      message_id: messageId,
      attachment_id: attachment.id,
      source_type: 'email_attachment',
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      matched_scope_item: matchedScopeItem,
      match_confidence: matchConfidence,
      notes: 'Cataloged from inbound attachment',
    });
    cataloged += 1;
  }

  for (const url of extractCandidateDownloadUrls(bodyText)) {
    const result = await maybeDownloadDirectArtifact({ caseData, messageId, url, fetchImpl, database });
    if (!result || result.skipped || !result.attachment) continue;
    const { matchedScopeItem, matchConfidence } = matchScopeItem(caseData, result.attachment);
    await database.createReceivedRecord({
      case_id: caseId,
      message_id: messageId,
      attachment_id: result.attachment.id,
      source_type: 'portal_download_link',
      source_url: url,
      filename: result.attachment.filename,
      content_type: result.attachment.content_type,
      size_bytes: result.attachment.size_bytes,
      matched_scope_item: matchedScopeItem,
      match_confidence: matchConfidence,
      notes: 'Downloaded from inbound delivery link',
    });
    cataloged += 1;
    downloaded += 1;
  }

  const report = await buildCaseCompletionReport(caseId, { db: database, caseData });
  const flaggedIncomplete = classification === 'PARTIAL_DELIVERY' || report.outstanding.length > 0;

  await database.logActivity(
    'records_delivery_cataloged',
    `Cataloged ${cataloged} delivered artifact(s) for case ${caseData.case_name}`,
    {
      case_id: caseId,
      actor_type: 'system',
      source_service: 'records_delivery_service',
      downloaded_count: downloaded,
      flagged_incomplete: flaggedIncomplete,
    }
  );

  if (flaggedIncomplete) {
    await database.logActivity(
      'delivery_incomplete_flagged',
      `Delivery for ${caseData.case_name} appears incomplete`,
      {
        case_id: caseId,
        actor_type: 'system',
        source_service: 'records_delivery_service',
        outstanding: report.outstanding,
      }
    );
  }

  return { cataloged, downloaded, flaggedIncomplete, report };
}

module.exports = {
  extractCandidateDownloadUrls,
  matchScopeItem,
  buildCaseCompletionReport,
  catalogMessageDelivery,
};
