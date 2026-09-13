/**
 * Bilingual README pairing.
 *
 * Both languages carry equal authority, so the pair has to move together. The
 * record in `README.i18n.yaml` holds the git blob hash of each side as of the last
 * confirmed-consistent state; these tests make a stale record fail rather than
 * trusting whoever edited last to remember.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(ROOT, name), 'utf8');

/** The same hash `git hash-object` computes, without depending on git. */
function blobHash(text) {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

const record = Object.fromEntries(
  read('README.i18n.yaml')
    .split('\n')
    .filter((line) => line.includes(': ') && !line.trimStart().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(': ') + 2).trim()]),
);

test('both READMEs exist and carry a switcher to the other', () => {
  const en = read('README.md');
  const zh = read('README.zh.md');
  assert.match(en, /^English \| \[中文\]\(README\.zh\.md\)$/m, 'the English side needs its switcher');
  assert.match(zh, /^\[English\]\(README\.md\) \| 中文$/m, 'the Chinese side needs its switcher');
  assert.equal(read('package.json').includes('README.zh.md'), true, 'both must ship');
});

test('the translation covers the same structure', () => {
  const count = (text, pattern) => (text.match(pattern) ?? []).length;
  const en = read('README.md');
  const zh = read('README.zh.md');
  assert.equal(count(zh, /^```/gm), count(en, /^```/gm), 'code fences must match');
  assert.equal(count(zh, /^#{1,6} /gm), count(en, /^#{1,6} /gm), 'headings must match');
  assert.equal(count(zh, /^\|/gm), count(en, /^\|/gm), 'table rows must match');
});

test('the pairing record matches the files as they are', () => {
  for (const name of ['README.md', 'README.zh.md']) {
    assert.ok(record[name] !== undefined, `README.i18n.yaml must record ${name}`);
    assert.equal(
      record[name],
      blobHash(read(name)),
      `${name} changed without re-recording the pair: run \`git hash-object README.md README.zh.md\` and update README.i18n.yaml`,
    );
  }
});
