/**
 * Capability taxonomy tests: the taxonomy must stay open, generic, and free of
 * any model or provider identity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Taxonomy,
  SEED_CAPABILITIES,
  SEED_IDS,
  synthesizeCapability,
  normalizeDescriptor,
} from '../lib/taxonomy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the seed taxonomy covers the required generic families', () => {
  const groups = new Set(SEED_CAPABILITIES.map((entry) => entry.group));
  for (const required of [
    'software',
    'data',
    'reasoning',
    'science',
    'research',
    'writing',
    'multimodal',
    'document',
    'web',
  ]) {
    assert.ok(groups.has(required), `taxonomy is missing the "${required}" family`);
  }
});

test('every seed descriptor is well formed and independently identified', () => {
  const ids = new Set();
  for (const descriptor of new Taxonomy().list()) {
    assert.match(descriptor.id, /^[a-z0-9][a-z0-9._-]*$/);
    assert.ok(descriptor.label.length > 0);
    assert.ok(descriptor.signals.length > 0, `${descriptor.id} has no signals`);
    assert.ok(!ids.has(descriptor.id), `duplicate capability id ${descriptor.id}`);
    ids.add(descriptor.id);
  }
  assert.equal(ids.size, SEED_IDS.length);
});

test('the taxonomy names no model, provider, or vendor', () => {
  // Guard the core requirement: capability descriptors must never encode a
  // model->domain mapping, so no route-like identity may appear in them.
  const forbidden = [
    'deepseek', 'gpt', 'claude', 'gemini', 'grok', 'qwen', 'kimi', 'glm',
    'openai', 'anthropic', 'moonshot', 'mistral', 'llama', 'commandcode',
    'provider', 'model:',
  ];
  const text = JSON.stringify(SEED_CAPABILITIES).toLowerCase();
  for (const name of forbidden) {
    assert.ok(!text.includes(name), `the seed taxonomy mentions "${name}"`);
  }
});

test('no source module hardcodes a model route outside documentation', () => {
  // The selection logic must read the live pool. This asserts the shipped logic
  // modules contain no concrete model id in CODE — prose is allowed, since the
  // modules explain themselves with real examples, and a guard that forbade those
  // would trade a real explanation for nothing. Imports of the host's own
  // `@deepseek-ai/*` packages are legitimate and are stripped first.
  const modelIds = ['deepseek-v4', 'deepseek-flash', 'gpt-4', 'gpt-5', 'claude-', 'gemini-', 'grok-', 'commandcode'];
  for (const file of [
    'taxonomy.js',
    'matching.js',
    'discovery.js',
    'engine.js',
    'tools.js',
    'assignments.js',
    'model-identity.js',
  ]) {
    const raw = readFileSync(join(ROOT, 'lib', file), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/@deepseek-ai\//g, '@host/')
      .toLowerCase();
    for (const name of modelIds) {
      assert.ok(!code.includes(name), `lib/${file} hardcodes the model id "${name}" in code`);
    }
  }
});

test('a synthesized descriptor is derived from the task vocabulary', () => {
  const descriptor = synthesizeCapability({
    label: 'Legal contract review',
    group: 'legal',
    keywords: ['contract', 'clause', 'liability'],
    minContextWindow: 64000,
  });
  assert.equal(descriptor.origin, 'synthesized');
  assert.ok(descriptor.id.startsWith('legal.'));
  const keywords = descriptor.signals.find((signal) => signal.type === 'keywords');
  assert.deepEqual(keywords.keywords, ['contract', 'clause', 'liability']);
  const context = descriptor.signals.find((signal) => signal.type === 'contextAtLeast');
  assert.equal(context.min, 64000);
});

test('a synthesized descriptor can be registered and persisted round-trip', () => {
  const taxonomy = new Taxonomy();
  const before = taxonomy.list().length;
  const descriptor = synthesizeCapability({
    label: 'Marine biology fieldwork',
    group: 'biology',
    keywords: ['coral', 'reef', 'salinity'],
  });
  taxonomy.register(descriptor);
  assert.equal(taxonomy.list().length, before + 1);
  assert.ok(taxonomy.has(descriptor.id));

  const persisted = taxonomy.customDescriptors();
  assert.equal(persisted.length, 1);

  const restored = new Taxonomy();
  assert.equal(restored.restore(persisted), 1);
  assert.ok(restored.has(descriptor.id));
  assert.equal(restored.get(descriptor.id).origin, 'synthesized');
});

test('a malformed descriptor is rejected rather than accepted silently', () => {
  assert.throws(() => normalizeDescriptor({ label: 'no id' }), /non-empty "id"/);
  assert.throws(() => normalizeDescriptor({ id: 'bad id!' }), /must match/);
  assert.throws(() => normalizeDescriptor({ id: 'ok', signals: [] }), /at least one signal/);
});

test('a descriptor that fails to restore does not poison the taxonomy', () => {
  const taxonomy = new Taxonomy();
  const accepted = taxonomy.restore([{ id: '' }, null, 42, { id: 'good.one', signals: [{ type: 'keywords', keywords: ['x'] }] }]);
  assert.equal(accepted, 1);
  assert.ok(taxonomy.has('good.one'));
});
