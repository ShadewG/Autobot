/**
 * Storage Service — S3-compatible object storage for attachments
 *
 * Supports Cloudflare R2, AWS S3, or any S3-compatible provider.
 * Falls back to Postgres BYTEA if no bucket is configured.
 *
 * Required env vars for R2/S3:
 *   STORAGE_BUCKET        — bucket name (e.g., "autobot-attachments")
 *   STORAGE_ENDPOINT      — S3 endpoint (e.g., "https://<account>.r2.cloudflarestorage.com")
 *   STORAGE_ACCESS_KEY    — access key ID
 *   STORAGE_SECRET_KEY    — secret access key
 *   STORAGE_PUBLIC_URL    — optional public URL prefix for serving files
 *   STORAGE_REGION        — optional region (default: "auto" for R2)
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

let s3Client = null;
let bucketName = null;
let publicUrlPrefix = null;

function isConfigured() {
    return !!(process.env.STORAGE_BUCKET && process.env.STORAGE_ENDPOINT &&
              process.env.STORAGE_ACCESS_KEY && process.env.STORAGE_SECRET_KEY);
}

function getClient() {
    if (s3Client) return s3Client;
    if (!isConfigured()) return null;

    s3Client = new S3Client({
        region: process.env.STORAGE_REGION || 'auto',
        endpoint: process.env.STORAGE_ENDPOINT,
        credentials: {
            accessKeyId: process.env.STORAGE_ACCESS_KEY,
            secretAccessKey: process.env.STORAGE_SECRET_KEY,
        },
    });
    bucketName = process.env.STORAGE_BUCKET;
    publicUrlPrefix = process.env.STORAGE_PUBLIC_URL || null;
    return s3Client;
}

/**
 * Build the S3 key for an attachment.
 * Format: attachments/{caseId}/{messageId}_{safeFilename}
 */
function buildKey(caseId, messageId, filename) {
    const safe = (filename || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_');
    return `attachments/${caseId}/${messageId}_${safe}`;
}

/**
 * Upload a buffer to object storage.
 * Returns { storageUrl, key } or null if not configured.
 */
async function upload(caseId, messageId, filename, buffer, contentType) {
    const client = getClient();
    if (!client || !buffer) return null;

    const key = buildKey(caseId, messageId, filename);

    await client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
    }));

    const storageUrl = publicUrlPrefix
        ? `${publicUrlPrefix.replace(/\/$/, '')}/${key}`
        : `s3://${bucketName}/${key}`;

    return { storageUrl, key };
}

/**
 * Download a file from object storage.
 * Returns a Buffer or null.
 */
async function download(key) {
    const client = getClient();
    if (!client) return null;

    const response = await client.send(new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
    }));

    const chunks = [];
    for await (const chunk of response.Body) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * Delete a file from object storage.
 */
async function remove(key) {
    const client = getClient();
    if (!client) return;

    await client.send(new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
    }));
}

module.exports = { isConfigured, upload, download, remove, buildKey };
