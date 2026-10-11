// Issue #259 (part of #82): the `usage.*` and `calls.*` key tables in docs/library.md and
// docs/library.es.md are hand-written prose next to a generated catalog (src/content/officeMessages.ts).
// Nothing stops them from drifting apart the next time a key is added, renamed or its text changes. This
// test parses both tables out of both guides and cross-checks them against OFFICE_MESSAGES, so a future
// library change that forgets to update one guide (or updates it with a typo) fails CI instead of shipping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OFFICE_MESSAGES } from '../src/content/officeMessages.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const EN_GUIDE = readFileSync(`${repoRoot}docs/library.md`, 'utf8');
const ES_GUIDE = readFileSync(`${repoRoot}docs/library.es.md`, 'utf8');

/**
 * Pulls the rows of the first markdown table that follows a `#### \`<prefix>.*\` (<count>)` heading.
 * `keyColumn` and `valueColumns` are 0-based indices into the pipe-separated cells (after the leading and
 * trailing empty cells from the `| a | b | c |` syntax are dropped).
 */
function parseKeyTable(content, prefix) {
  const headingPattern = new RegExp(`^#### \`${prefix}\\.\\*\` \\((\\d+)\\)$`, 'm');
  const headingMatch = headingPattern.exec(content);
  assert.ok(headingMatch, `expected a "#### \`${prefix}.*\` (N)" heading`);
  const declaredCount = Number(headingMatch[1]);

  const afterHeading = content.slice(headingMatch.index + headingMatch[0].length);
  const lines = afterHeading.split('\n');
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (!inTable) {
      if (line.startsWith('|')) inTable = true;
      else if (line.trim() === '') continue;
      else break;
      if (!inTable) continue;
    }
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^-+$/.test(cell))) continue; // the `|---|---|---|` separator row
    if (cells[0] === 'Key' || cells[0] === 'Clave') continue; // the header row
    rows.push(cells);
  }
  return { declaredCount, rows };
}

function keysWithPrefix(messages, prefix) {
  return Object.keys(messages).filter((key) => key.startsWith(`${prefix}.`));
}

for (const prefix of ['usage', 'calls']) {
  test(`${prefix}.* table: the heading count matches the number of rows, in both guides`, () => {
    const en = parseKeyTable(EN_GUIDE, prefix);
    const es = parseKeyTable(ES_GUIDE, prefix);
    assert.equal(en.rows.length, en.declaredCount, `docs/library.md's "${prefix}.*" heading count must match its row count`);
    assert.equal(es.rows.length, es.declaredCount, `docs/library.es.md's "${prefix}.*" heading count must match its row count`);
  });

  test(`${prefix}.* table: the heading count matches OFFICE_MESSAGES`, () => {
    const actualKeys = keysWithPrefix(OFFICE_MESSAGES.en, prefix);
    const { declaredCount } = parseKeyTable(EN_GUIDE, prefix);
    assert.equal(
      declaredCount,
      actualKeys.length,
      `OFFICE_MESSAGES has ${actualKeys.length} "${prefix}.*" keys; the guide heading says ${declaredCount}`,
    );
  });

  test(`${prefix}.* table: every key, and both languages' text, match OFFICE_MESSAGES`, () => {
    const actualKeys = new Set(keysWithPrefix(OFFICE_MESSAGES.en, prefix));
    const en = parseKeyTable(EN_GUIDE, prefix);
    const es = parseKeyTable(ES_GUIDE, prefix);

    const documentedKeys = new Set(en.rows.map((row) => row[0].replace(/`/g, '')));
    assert.deepEqual(
      documentedKeys,
      actualKeys,
      `docs/library.md's "${prefix}.*" table must list exactly the "${prefix}.*" keys of OFFICE_MESSAGES.en`,
    );
    assert.deepEqual(
      new Set(es.rows.map((row) => row[0].replace(/`/g, ''))),
      actualKeys,
      `docs/library.es.md's "${prefix}.*" table must list exactly the "${prefix}.*" keys of OFFICE_MESSAGES.en`,
    );

    for (const [rawKey, english, spanish] of en.rows) {
      const key = rawKey.replace(/`/g, '');
      assert.equal(english, OFFICE_MESSAGES.en[key], `docs/library.md: "${key}" English text does not match OFFICE_MESSAGES.en`);
      assert.equal(spanish, OFFICE_MESSAGES.es[key], `docs/library.md: "${key}" Spanish text does not match OFFICE_MESSAGES.es`);
    }
    for (const [rawKey, spanish, english] of es.rows) {
      const key = rawKey.replace(/`/g, '');
      assert.equal(english, OFFICE_MESSAGES.en[key], `docs/library.es.md: "${key}" English text does not match OFFICE_MESSAGES.en`);
      assert.equal(spanish, OFFICE_MESSAGES.es[key], `docs/library.es.md: "${key}" Spanish text does not match OFFICE_MESSAGES.es`);
    }
  });
}
