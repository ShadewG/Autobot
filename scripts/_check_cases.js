const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL });

function encryptPassword(password) {
  const key = crypto.createHash('sha256').update(process.env.PORTAL_ENCRYPTION_KEY || 'default-key-change-in-production-32').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function main() {
  const encPw = encryptPassword('Password123!');

  const result = await pool.query(
    `INSERT INTO portal_accounts (portal_url, portal_domain, portal_type, email, password_encrypted, first_name, last_name, additional_info, account_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, portal_domain, email`,
    [
      'https://lubbocktx.govqa.us/WEBAPP/_rs/SupportHome.aspx',
      'lubbocktx.govqa.us',
      'govqa',
      'requests@foib-request.com',
      encPw,
      'Samuel',
      'Hylton',
      JSON.stringify({ title: 'Documentary Researcher', company: 'Dr Insanity / FOIA Request Team', phone: '209-800-7702' }),
      'active'
    ]
  );
  console.log('Created portal account:', result.rows[0]);

  // Reset case 25156
  await pool.query(
    `UPDATE cases SET status = 'ready_to_send', substatus = NULL, last_portal_status = NULL, last_portal_run_id = NULL, last_portal_task_url = NULL WHERE id = 25156`
  );
  console.log('Reset case #25156 to ready_to_send');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
