require('dotenv').config();
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('railway.internal')) {
    process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
}

const portalAgent = require('../services/portal-agent-service-skyvern');
const db = require('../services/database');

(async () => {
    const r = await db.query('SELECT * FROM cases WHERE id = 25156');
    const caseData = r.rows[0];
    if (!caseData) { console.error('Case not found'); process.exit(1); }

    console.log('Case:', caseData.case_name);
    console.log('Portal:', caseData.portal_url);
    console.log('');

    const result = await portalAgent.submitToPortal(caseData, caseData.portal_url, { dryRun: false });
    console.log('\n=== FINAL RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
