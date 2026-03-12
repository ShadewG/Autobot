const fs = require('fs');
const path = require('path');
const database = require('./database');

const DEFAULT_SCREENSHOT_STORAGE_ROOT = path.join(process.cwd(), 'data', 'screenshots');

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function slugify(value) {
    return String(value || 'portal')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'portal';
}

function getPortalScreenshotStorageRoot() {
    return process.env.PORTAL_SCREENSHOT_STORAGE_DIR || DEFAULT_SCREENSHOT_STORAGE_ROOT;
}

function buildPortalScreenshotPublicUrl(caseId, filename) {
    return `/api/screenshots/${caseId}/${filename}`;
}

async function persistPortalScreenshot({
    caseId,
    runId = null,
    sequenceIndex = null,
    status = null,
    label = null,
    sourcePath = null,
    buffer = null,
    extension = null,
    metadata = {},
    skipActivityLog = false,
    skipCaseUpdate = false,
}) {
    if (!caseId || (!sourcePath && !buffer)) return null;

    const inferredExtension = extension || path.extname(sourcePath || '') || '.png';
    const normalizedExtension = inferredExtension.startsWith('.') ? inferredExtension : `.${inferredExtension}`;
    const storageRoot = ensureDir(getPortalScreenshotStorageRoot());
    const caseDir = ensureDir(path.join(storageRoot, String(caseId)));
    const filename = `${Date.now()}-${slugify(status || 'portal-screenshot')}${sequenceIndex !== null ? `-${sequenceIndex}` : ''}${normalizedExtension}`;
    const destinationPath = path.join(caseDir, filename);

    if (buffer) {
        fs.writeFileSync(destinationPath, buffer);
    } else {
        fs.copyFileSync(sourcePath, destinationPath);
    }

    const publicUrl = buildPortalScreenshotPublicUrl(caseId, filename);
    const activityLabel = label || `Portal screenshot${sequenceIndex !== null ? ` #${sequenceIndex + 1}` : ''}`;

    if (!skipActivityLog) {
        try {
            await database.logActivity('portal_screenshot', activityLabel, {
                case_id: caseId,
                url: publicUrl,
                persistent_url: publicUrl,
                run_id: runId,
                sequence_index: sequenceIndex,
                skyvern_status: status,
                portal_status: status,
                ...metadata,
            });
        } catch (error) {
            console.warn(`Portal screenshot log failed: ${error.message}`);
        }
    }

    if (!skipCaseUpdate) {
        try {
            await database.updateCasePortalStatus(caseId, {
                last_portal_screenshot_url: publicUrl,
            });
        } catch (error) {
            console.warn(`Portal screenshot case update failed: ${error.message}`);
        }
    }

    return {
        filePath: destinationPath,
        publicUrl,
    };
}

module.exports = {
    getPortalScreenshotStorageRoot,
    buildPortalScreenshotPublicUrl,
    persistPortalScreenshot,
};
