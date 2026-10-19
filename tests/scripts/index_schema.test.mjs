import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const schema = fs.readFileSync(new URL('../../web/lib/schema.sql', import.meta.url), 'utf8');
test('PostgreSQL migration preserves legacy rows and isolates duplicate dockets and verdict foreign keys', async () => {
  const db = new PGlite();
  try {
    await db.exec(schema);
    const { rows: members } = await db.query("INSERT INTO members(privy_did,email_hash) VALUES ('test:legacy','hash-a'),('test:current','hash-b') RETURNING id");
    const [first, second] = members;
    const insert = `INSERT INTO cases(docket,member_id,plan_id,family_id,state,denial_rationale,service_month,disputed_amount_atto,evidence_sha256)
      VALUES ('OMB-2026-000001',$1,'PLAN','family','TX','Synthetic denial','2026-04',1,$2)`;
    await db.query(insert, [first.id, 'a'.repeat(64)]);
    await db.exec(schema);
    const oldCourt = 'legacy:unscoped';
    const current = `0x${'ab'.repeat(20)}`;
    await db.query(`INSERT INTO protocol_cases(court_address,docket,member_id,plan_id,family_id,state,denial_rationale,service_month,disputed_amount_atto,evidence_sha256)
      VALUES ($1,'OMB-2026-000001',$2,'PLAN','family','TX','Synthetic denial','2026-04',1,$3)`, [current, second.id, 'b'.repeat(64)]);
    const { rows } = await db.query('SELECT court_address,member_id FROM protocol_cases ORDER BY court_address');
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.court_address === oldCourt).member_id, first.id);
    assert.equal(rows.find((r) => r.court_address === current).member_id, second.id);
    await db.exec(schema);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM protocol_cases')).rows[0].n, 2);
    await assert.rejects(db.query(`INSERT INTO protocol_cases SELECT * FROM protocol_cases WHERE court_address = $1`, [current]), /duplicate key/);
    await assert.rejects(db.query(`INSERT INTO protocol_verdicts(court_address,docket,overturn_recommended,ground,clause_id,recoverable_band,confidence,digest)
      VALUES ($1,'OTHER-CASE',true,'MEDICAL_NECESSITY','clause',1,80,$2)`, [current, 'c'.repeat(64)]), /foreign key/);
  } finally { await db.close(); }
});
