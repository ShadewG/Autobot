/**
 * Dedup agencies table: merge duplicates, keeping the row with the most data.
 * Updates all FK references (cases, case_agencies, agency_comments, agency_sync_log)
 * before deleting duplicates.
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function dedup() {
  // Find all duplicate groups
  const dupes = await pool.query(`
    SELECT LOWER(TRIM(name)) as normalized_name, array_agg(id ORDER BY id) as ids
    FROM agencies
    GROUP BY LOWER(TRIM(name))
    HAVING COUNT(*) > 1
  `);

  console.log(`Found ${dupes.rows.length} duplicate groups (${dupes.rows.reduce((s, r) => s + r.ids.length - 1, 0)} removable rows)`);

  let merged = 0, deleted = 0;

  for (const group of dupes.rows) {
    const ids = group.ids;
    // Fetch all rows in this group
    const rows = await pool.query(
      'SELECT * FROM agencies WHERE id = ANY($1) ORDER BY id',
      [ids]
    );

    // Score each row by how much useful data it has
    function score(row) {
      let s = 0;
      if (row.state && row.state !== '{}') s += 10;
      if (row.email_foia) s += 5;
      if (row.email_main) s += 3;
      if (row.portal_url) s += 5;
      if (row.phone) s += 2;
      if (row.address) s += 1;
      if (row.contact_name) s += 2;
      if (row.county) s += 1;
      if (row.portal_provider) s += 1;
      if (row.notes) s += 1;
      return s;
    }

    // Pick the best row (highest score, then lowest ID for stability)
    const scored = rows.rows.map(r => ({ ...r, _score: score(r) }));
    scored.sort((a, b) => b._score - a._score || a.id - b.id);
    const keep = scored[0];
    const removeIds = scored.slice(1).map(r => r.id);

    if (removeIds.length === 0) continue;

    console.log(`  Keeping id=${keep.id} (score=${keep._score}) for "${keep.name}", removing ids=[${removeIds.join(',')}]`);

    // Merge non-null fields from duplicates into keeper
    const mergeFields = ['state', 'email_foia', 'email_main', 'portal_url', 'phone', 'address',
      'contact_name', 'county', 'portal_provider', 'portal_url_alt', 'request_form_url',
      'preferred_method', 'notes', 'mailing_address', 'fax'];
    const updates = {};
    for (const dupe of scored.slice(1)) {
      for (const field of mergeFields) {
        if (!keep[field] || keep[field] === '{}') {
          if (dupe[field] && dupe[field] !== '{}') {
            updates[field] = dupe[field];
            keep[field] = dupe[field]; // prevent overwriting from later dupes
          }
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      const setClauses = Object.entries(updates).map(([k, v], i) => `${k} = $${i + 2}`);
      const values = [keep.id, ...Object.values(updates)];
      await pool.query(`UPDATE agencies SET ${setClauses.join(', ')} WHERE id = $1`, values);
      console.log(`    Merged fields: ${Object.keys(updates).join(', ')}`);
    }

    // Re-point FK references
    for (const table of ['cases', 'case_agencies', 'agency_comments', 'agency_sync_log']) {
      const result = await pool.query(
        `UPDATE ${table} SET agency_id = $1 WHERE agency_id = ANY($2) RETURNING id`,
        [keep.id, removeIds]
      );
      if (result.rowCount > 0) {
        console.log(`    Updated ${result.rowCount} ${table} rows`);
      }
    }

    // Delete duplicates
    await pool.query('DELETE FROM agencies WHERE id = ANY($1)', [removeIds]);
    deleted += removeIds.length;
    merged++;
  }

  console.log(`\nDone: merged ${merged} groups, deleted ${deleted} duplicate rows`);

  // Verify no more duplicates
  const check = await pool.query(`
    SELECT COUNT(*) as remaining FROM (
      SELECT LOWER(TRIM(name)) FROM agencies GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1
    ) sub
  `);
  console.log('Remaining duplicate groups:', check.rows[0].remaining);

  await pool.end();
}

dedup().catch(e => { console.error(e); process.exit(1); });
