/**
 * Locale tests.
 *
 * Two copies of the dictionaries exist on purpose: `lib/locales.js` is the
 * importable source of truth, and `lib/client.js` embeds them because a static
 * client bundle is served verbatim and imports nothing. These tests make that
 * duplication safe by asserting the copies are identical, and they pin the
 * properties that make the UI actually follow the harness language.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTIONARIES, LOCALE_NAMESPACE, en, zh } from '../lib/locales.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

/**
 * Extract the embedded dictionaries by executing the bundle against a mock
 * loader. Parsing the source text would be brittle; running it is authoritative.
 */
async function embeddedDictionaries() {
  let registration
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  const previousWindow = globalThis.window
  globalThis.window = window
  const scratch = join(ROOT, 'test', '.locale-scratch.mjs')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { pathToFileURL } = await import('node:url')
  const directory = mkdtempSync(join(tmpdir(), 'orch-locale-'))
  const bundlePath = join(directory, 'client.mjs')
  writeFileSync(bundlePath, clientSource, 'utf8')
  try {
    await import(pathToFileURL(bundlePath).href)
  } finally {
    globalThis.window = previousWindow
    rmSync(directory, { recursive: true, force: true })
  }
  assert.ok(registration, 'the bundle must register through the module loader')

  // Recover the dictionaries through the one surface that exposes them: the
  // translation fallback, probed with a fake locale service.
  const captured = []
  const plugin = registration.factory((id) => {
    if (id === 'react') {
      return {
        createElement: () => null,
        useState: (initial) => [initial, () => {}],
        useEffect: () => {},
        useCallback: (fn) => fn,
      }
    }
    throw new Error(`unexpected module request: ${id}`)
  })
  plugin.apply({
    effect: (factory) => { factory() },
    slots: { inject: (_key, callback) => callback(), register: () => () => {} },
    locale: {
      register: (ns, dicts) => { captured.push({ ns, dicts }); return () => {} },
      bind: () => (key) => key,
    },
  })
  assert.equal(captured.length, 1)
  return captured[0]
}

test('the embedded dictionaries match the importable source of truth', async () => {
  const { ns, dicts } = await embeddedDictionaries()
  assert.equal(ns, LOCALE_NAMESPACE)
  assert.deepEqual(
    Object.keys(dicts).sort(),
    ['en', 'zh'],
    'both built-in locales must be registered in one call',
  )
  assert.deepEqual(dicts.en, en, 'the embedded English dictionary has drifted from lib/locales.js')
  assert.deepEqual(dicts.zh, zh, 'the embedded Chinese dictionary has drifted from lib/locales.js')
});

test('both locales carry exactly the same key set', () => {
  const englishKeys = Object.keys(en).sort()
  const chineseKeys = Object.keys(zh).sort()
  assert.deepEqual(chineseKeys, englishKeys, 'a key present in one locale but not the other');
  assert.ok(englishKeys.length > 60, `expected a full dictionary, found ${englishKeys.length} keys`);
});

test('every placeholder is present in both locales for the same key', () => {
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const mismatches = []
  for (const key of Object.keys(en)) {
    const a = placeholders(en[key])
    const b = placeholders(zh[key])
    if (a.join(',') !== b.join(',')) mismatches.push(`${key}: en[${a}] vs zh[${b}]`)
  }
  assert.deepEqual(mismatches, [], 'a translation dropped or invented an interpolation placeholder');
});

test('no translated string is left empty or untranslated by accident', () => {
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(typeof value === 'string' && value.trim().length > 0, `zh["${key}"] is empty`);
  }
  for (const [key, value] of Object.entries(en)) {
    assert.ok(typeof value === 'string' && value.trim().length > 0, `en["${key}"] is empty`);
  }
});

test('the Chinese dictionary actually contains CJK for user-facing copy', () => {
  // Guards the failure mode where a translation is added as an English copy.
  const mustBeCjk = [
    'doc.title',
    'doc.subtitle',
    'mode.title',
    'mode.auto',
    'mode.guided',
    'capability.title',
    'pool.title',
    'preferences.title',
    'preview.title',
    'capacity.title',
  ]
  for (const key of mustBeCjk) {
    assert.match(zh[key], /[\u4e00-\u9fff]/, `zh["${key}"] has no CJK text: ${JSON.stringify(zh[key])}`);
  }
});

test('the dictionaries cover every surface the panel renders', () => {
  // A representative prefix per surface; a whole section left out is the
  // realistic regression, so assert each surface has a cluster of keys.
  for (const prefix of [
    'doc.',
    'health.',
    'mode.',
    'capability.',
    'pool.',
    'preferences.',
    'preview.',
    'capacity.',
    // No 'strip.' here any more: the ambient composer strip was deliberately
    // removed (the board replaced it), so that surface has one surviving key and
    // asserting a cluster for it would pin a surface the panel does not render.
    'tier.',
    'assignment.',
  ]) {
    const count = Object.keys(en).filter((key) => key.startsWith(prefix)).length
    assert.ok(count >= 2, `the "${prefix}" surface has only ${count} key(s)`)
  }
});

test('no hardcoded user-facing English remains in the client bundle', () => {
  // The panel must not render literal prose outside the dictionaries. Comments
  // are stripped first, because prose there is documentation, not copy, and
  // identifiers (column keys, tier ids, route fragments) are legitimately literal.
  const generated = clientSource.slice(
    clientSource.indexOf('BEGIN GENERATED DICTIONARIES'),
    clientSource.indexOf('END GENERATED DICTIONARIES'),
  )
  const code = clientSource
    .replace(generated, '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  // Only single-quoted string literals can become rendered text here.
  const literals = [...code.matchAll(/'([^'\\\n]{4,})'/g)].map((match) => match[1])

  const forbidden = [
    'Model pool',
    'Capability areas',
    'Routing preview',
    'Routing capacity',
    'Prefer lower-cost',
    'Max parallel',
    'No delegation needed',
    'Discovered live',
    'in flight',
    'model(s)',
  ]
  for (const phrase of forbidden) {
    const hit = literals.find((literal) => literal.includes(phrase))
    assert.equal(
      hit,
      undefined,
      `the client bundle still renders the literal text ${JSON.stringify(phrase)} outside its dictionaries`,
    )
  }
});

test('generic and technical terms stay untranslated', () => {
  // Policy: terms the user asked not to translate — generic vocabulary (`host`,
  // `requires`) and harness/pipeline identifiers (`provider`, `route`) — must
  // keep their English form in every locale, because translating them either
  // misstates the identifier or diverges from what the tools report.
  const mustStayEnglish = {
    'health.host': /\bhost\b/,
    'health.requires': /\brequires\b/,
    'pool.summary': /\bprovider\b/,
    'pool.columnRoute': /route/i,
    'preview.columnRoute': /route/i,
  }
  for (const [key, pattern] of Object.entries(mustStayEnglish)) {
    assert.ok(pattern.test(en[key]), `en["${key}"] lost its English term: ${JSON.stringify(en[key])}`)
    assert.ok(pattern.test(zh[key]), `zh["${key}"] translated a term that must stay English: ${JSON.stringify(zh[key])}`)
    assert.ok(
      !/[\u4e00-\u9fff]/.test(zh[key].replace(/\{[^}]*\}/g, '')) ||
        /host|requires|provider|route/i.test(zh[key]),
      `zh["${key}"] should keep its technical term`,
    )
  }
});

test('version and release identifiers are never translated', () => {
  // A version string such as `0.1.5-rc.1` is data, not prose: it must pass
  // through both dictionaries untouched as a placeholder.
  for (const key of ['health.host', 'health.requires']) {
    assert.match(en[key], /\{version\}|\{range\}/, `en["${key}"] must interpolate the raw identifier`)
    assert.match(zh[key], /\{version\}|\{range\}/, `zh["${key}"] must interpolate the raw identifier`)
  }
  assert.ok(!/rc|版本号/.test(zh['health.requires']), 'the release tag must not be spelled out');
});

test('identifiers that name real strings are not translated anywhere', () => {
  // These keys carry values that also appear verbatim in the tool output, so a
  // translation would make the panel disagree with what the agent reports.
  // The model-tier names used to be here. The pool no longer shows a tier column
  // — it is internal vocabulary, and the columns beside it (context, cost) are the
  // measured inputs it summarised — so those keys are gone rather than dead.
  const dataKeys = ['pool.contextValue', 'pool.noValue', 'preview.poolCount']
  for (const key of dataKeys) {
    assert.ok(key in en && key in zh, `${key} must exist in both locales`)
  }
  // The context figure keeps its `k` suffix in both languages.
  for (const dict of [en, zh]) {
    assert.match(dict['pool.contextValue'], /\{value\}k$/, 'the k suffix is a unit, not prose');
  }
});
