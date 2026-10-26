import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { readMigrations } from '../../db/migration-runner.mjs';

function fixture(t, files) {
  const directory = mkdtempSync(join(tmpdir(), 'farm-migrations-'));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith('farm-migrations-'));
    rmSync(directory, { recursive: true });
  });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(directory, name), sql);
  return directory;
}

test('migration checksums agree across Windows and Unix line endings', (t) => {
  const a = readMigrations(fixture(t, { '001_initial.sql': '-- test\r\nSELECT 1;\r\n' }));
  const b = readMigrations(fixture(t, { '001_initial.sql': '-- test\nSELECT 1;\n' }));
  assert.equal(a[0].checksum, b[0].checksum);
});

test('missing or duplicated migration numbers and malformed names are refused', (t) => {
  for (const files of [
    { '002_gap.sql': 'SELECT 1;' },
    { '001_first.sql': 'SELECT 1;', '001_duplicate.sql': 'SELECT 2;' },
    { '1_bad.sql': 'SELECT 1;' },
  ]) assert.throws(() => readMigrations(fixture(t, files)), /consecutively/);
});

test('empty migration directories and comment-only migrations fail', (t) => {
  assert.throws(() => readMigrations(fixture(t, {})), /No SQL/);
  assert.throws(() => readMigrations(fixture(t, { '001_empty.sql': '-- nothing\n/* here */' })), /Empty migration/);
});

test('SQL files cannot commit or replace the runner transaction', (t) => {
  for (const verb of ['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT x', 'START TRANSACTION', "PREPARE TRANSACTION 'x'"]) {
    assert.throws(() => readMigrations(fixture(t, { '001_control.sql': `-- header\n${verb};` })), /Transaction control/);
  }
});

test('transaction words in comments and string values remain valid SQL', (t) => {
  assert.equal(readMigrations(fixture(t, { '001_text.sql': "-- COMMIT;\nSELECT 'BEGIN; END;';" })).length, 1);
});
