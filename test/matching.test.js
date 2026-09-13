/**
 * Matching tests: dynamic pool changes, hard-requirement rejection, capability
 * matching with no model-name knowledge, and new-domain synthesis.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Taxonomy } from '../lib/taxonomy.js';
import { buildProfile, ModelPool, discoverModels } from '../lib/discovery.js';
import {
  analysisFromModel,
  analysisFromText,
  chooseRoute,
  inferComplexity,
  rankModels,
} from '../lib/matching.js';

/** Build a profile without touching a host. */
function profile(provider, model, { name, description, modalities, contextWindow, defaultMaxTokens, efforts } = {}) {
  return buildProfile(
    {
      modalities,
      contextWindow,
      defaultMaxTokens,
      efforts,
      defaultEffort: undefined,
      name,
      description,
    },
    provider,
    model,
  );
}

/** A pool backed by literal profiles, without any host service. */
function poolOf(profiles) {
  const pool = new ModelPool();
  pool.models = undefined;
  // Replace the private list by going through the public surface used by tests.
  Object.defineProperty(pool, 'models', { value: () => profiles, configurable: true });
  Object.defineProperty(pool, 'providers', {
    value: () => [...new Set(profiles.map((entry) => entry.provider))],
    configurable: true,
  });
  Object.defineProperty(pool, 'discoveredAt', { value: () => Date.now(), configurable: true });
  Object.defineProperty(pool, 'problems', { value: () => [], configurable: true });
  Object.defineProperty(pool, 'lastError', { value: () => undefined, configurable: true });
  Object.defineProperty(pool, 'get', {
    value: (route) => profiles.find((entry) => entry.route === route),
    configurable: true,
  });
  return pool;
}

test('a depth-heavy task requires an evidenced reasoning route', () => {
  const taxonomy = new Taxonomy();
  const plain = profile('p1', 'plain-model', {
    name: 'Fast model',
    description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
    contextWindow: 1_000_000,
  });
  const reasoning = profile('p1', 'reasoning-model', {
    name: 'Pro model',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex tasks.',
    contextWindow: 1_000_000,
    efforts: ['off', 'low', 'high', 'max'],
  });
  const pool = poolOf([plain, reasoning]);

  // "prove ... derive" is a depth cue: it routes on measured capability, not on
  // whether the model's own prose happens to mention mathematics.
  const analysis = analysisFromText(taxonomy, 'Prove this theorem and derive the general result.');
  assert.ok(
    analysis.requirements.some((entry) => entry.capability === 'depth.difficult'),
    'a depth requirement must be derived from the task',
  );

  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates[0].model, 'reasoning-model');
  const rejectedPlain = ranked.rejected.find((entry) => entry.route === 'p1/plain-model');
  assert.ok(rejectedPlain, 'a route with no reasoning effort must be rejected, not merely outranked');
  assert.match(rejectedPlain.reason, /reasoning/i);
});

test('a domain-free depth cue routes without any domain vocabulary', () => {
  const taxonomy = new Taxonomy();
  // Neither description mentions the subject at all, and the task uses no
  // domain term that appears in any descriptor. Routing must still be correct.
  const shallow = profile('p1', 'a-model', { name: 'Alpha', contextWindow: 200000 });
  const deep = profile('p1', 'b-model', {
    name: 'Beta',
    contextWindow: 200000,
    efforts: ['high'],
  });
  const pool = poolOf([shallow, deep]);
  const analysis = analysisFromText(taxonomy, 'Carefully diagnose why the numbers disagree.');
  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates[0].route, 'p1/b-model');
});

test('geometric-mean scoring does not let one strength mask a failed requirement', () => {
  const taxonomy = new Taxonomy();
  // The specialist is excellent at the domain keyword but exposes no reasoning;
  // the generalist exposes reasoning but lacks the keyword. The depth
  // requirement is what the task actually needs, so the generalist wins.
  const keywordOnly = profile('p1', 'keyword-only', {
    name: 'Maths model',
    description: 'mathematics algebra calculus proof theorem equation',
    contextWindow: 200000,
  });
  const reasoningOnly = profile('p1', 'reasoning-only', {
    name: 'General model',
    description: 'careful multi-step work',
    contextWindow: 200000,
    efforts: ['high'],
  });
  const pool = poolOf([keywordOnly, reasoningOnly]);
  const analysis = analysisFromText(taxonomy, 'Prove the theorem.');

  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates.length, 1);
  assert.equal(ranked.candidates[0].route, 'p1/reasoning-only');
  assert.match(
    ranked.rejected.find((entry) => entry.route === 'p1/keyword-only').reason,
    /reasoning/i,
  );
});

test('an image task rejects a model that declares text-only input', () => {
  const taxonomy = new Taxonomy();
  const textOnly = profile('p1', 'text-only', {
    name: 'Text only',
    description: 'Text model',
    contextWindow: 128000,
    modalities: ['text'],
  });
  const vision = profile('p1', 'vision', {
    name: 'Vision model',
    description: 'Understands images and screenshots',
    contextWindow: 128000,
    modalities: ['text', 'image'],
  });
  const pool = poolOf([textOnly, vision]);

  const analysis = analysisFromText(taxonomy, 'Read this screenshot and describe the UI.');
  const ranked = rankModels(pool, taxonomy, analysis, {});

  assert.equal(ranked.candidates[0].model, 'vision');
  const rejectedTextOnly = ranked.rejected.find((entry) => entry.route === 'p1/text-only');
  assert.ok(rejectedTextOnly, 'the text-only model must be rejected, not merely down-ranked');
  assert.match(rejectedTextOnly.reason, /image/i);
});

test('an unverified modality is refused rather than assumed to work', () => {
  const taxonomy = new Taxonomy();
  // `inputModalities` absent means unknown on the host. It must not be treated
  // as image-capable.
  const unknown = profile('p1', 'unknown-modality', { name: 'Unknown', contextWindow: 128000 });
  const pool = poolOf([unknown]);
  const analysis = analysisFromText(taxonomy, 'Describe the figure in this image.');
  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates.length, 0, 'an unverified modality must not be routed to');
  assert.match(ranked.rejected[0].reason, /image/i);
});

test('a hard context requirement rejects a model below the floor', () => {
  const taxonomy = new Taxonomy();
  const small = profile('p1', 'small-context', { name: 'Small', contextWindow: 8000 });
  const large = profile('p1', 'large-context', {
    name: 'Large',
    description: 'long context documents',
    contextWindow: 200000,
  });
  const pool = poolOf([small, large]);

  const analysis = {
    summary: 'Analyze a very long document',
    complexity: 'specialist',
    requirements: [{ capability: 'long.context', weight: 1, required: true, minContextWindow: 128000 }],
    source: 'model',
  };
  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates[0].route, 'p1/large-context');
  assert.ok(ranked.rejected.some((entry) => entry.route === 'p1/small-context'));
});

test('the pool is re-read, so a model that appears becomes selectable', () => {
  const taxonomy = new Taxonomy();
  const before = poolOf([
    profile('p1', 'weak', { name: 'Weak', description: 'routine tasks', contextWindow: 8000 }),
  ]);
  const analysis = analysisFromModel(taxonomy, {
    summary: 'Difficult reasoning',
    complexity: 'specialist',
    requirements: [{ capability: 'reasoning.general', weight: 1, keywords: ['reasoning'] }],
  });

  const firstPass = rankModels(before, taxonomy, analysis, {});
  assert.equal(firstPass.candidates[0].model, 'weak');

  const after = poolOf([
    profile('p1', 'weak', { name: 'Weak', description: 'routine tasks', contextWindow: 8000 }),
    profile('p1', 'strong', {
      name: 'Strong',
      description: 'difficult reasoning and planning',
      contextWindow: 200000,
      efforts: ['high'],
    }),
  ]);
  const secondPass = rankModels(after, taxonomy, analysis, {});
  assert.equal(secondPass.candidates[0].model, 'strong', 'the newly discovered model must win');
});

test('a capability the taxonomy does not know is synthesized, not refused', () => {
  const taxonomy = new Taxonomy();
  const analysis = analysisFromModel(taxonomy, {
    summary: 'Review a maritime insurance contract',
    complexity: 'specialist',
    domains: ['maritime law'],
    requirements: [
      {
        capability: 'legal.contract-review',
        weight: 0.9,
        required: true,
        keywords: ['contract', 'clause', 'liability', 'legal'],
        label: 'Contract review',
        group: 'legal',
      },
    ],
  });

  assert.equal(analysis.requirements.length, 1, 'the requirement must survive analysis');
  assert.ok(taxonomy.has('legal.contract-review'), 'the new capability must be registered');
  assert.equal(taxonomy.get('legal.contract-review').origin, 'synthesized');

  const pool = poolOf([
    profile('p1', 'lawyer', {
      name: 'Legal model',
      description: 'careful legal contract clause liability analysis',
      contextWindow: 128000,
    }),
  ]);
  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates[0].model, 'lawyer');
});

test('an empty pool reports emptiness instead of inventing a route', () => {
  const taxonomy = new Taxonomy();
  const pool = poolOf([]);
  const analysis = analysisFromText(taxonomy, 'Write a program.');
  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates.length, 0);
  assert.equal(ranked.summary.poolEmpty, true);
  assert.equal(chooseRoute(pool, taxonomy, { capability: 'software.implementation', weight: 1 }).chosen, undefined);
});

test('denied and allowed route preferences are honoured', () => {
  const taxonomy = new Taxonomy();
  const pool = poolOf([
    profile('p1', 'a', { name: 'A', description: 'coding implementation', contextWindow: 64000 }),
    profile('p1', 'b', { name: 'B', description: 'coding implementation', contextWindow: 64000 }),
  ]);
  const analysis = analysisFromText(taxonomy, 'Implement the feature in the codebase.');

  const denied = rankModels(pool, taxonomy, analysis, {
    preferences: { deniedRoutes: ['p1/a'] },
  });
  assert.ok(!denied.candidates.some((entry) => entry.route === 'p1/a'));

  const allowed = rankModels(pool, taxonomy, analysis, {
    preferences: { allowedRoutes: ['p1/b'] },
  });
  assert.deepEqual(allowed.candidates.map((entry) => entry.route), ['p1/b']);
});

test('complexity inference distinguishes simple from multi-domain work', () => {
  assert.equal(inferComplexity([], 'what is a monad'), 'trivial');
  const single = analysisFromText(new Taxonomy(), 'Implement the parser in Python.');
  assert.ok(['simple', 'specialist'].includes(single.complexity));
  const multi = analysisFromText(
    new Taxonomy(),
    'Research the literature, then run the statistical analysis, then translate the report for the client.',
  );
  assert.equal(multi.complexity, 'complex');
});

test('discovery tolerates a provider whose listing throws', async () => {
  const ctx = {
    get(key) {
      if (key !== 'llm') return undefined;
      return {
        listProviders: () => [
          { id: 'good', name: 'Good' },
          { id: 'broken', name: 'Broken' },
        ],
        listModels: async (provider) => {
          if (provider === 'broken') throw new Error('plan does not include this provider');
          return [{ provider: 'good', id: 'ok', name: 'OK', inputModalities: ['text'] }];
        },
        resolveModelInfo: async (provider, model) => ({
          provider,
          id: model,
          name: 'OK',
          inputModalities: ['text'],
          context: { contextWindow: 64000 },
        }),
      };
    },
  };
  const result = await discoverModels(ctx, {});
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].route, 'good/ok');
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /broken/);
});

test('a deployment output cap is never a hard rejection', () => {
  const taxonomy = new Taxonomy();
  // The deployment sends a small cap, but that is not the model's ceiling.
  const capped = profile('p1', 'capped', {
    name: 'Capped',
    description: 'coding implementation',
    contextWindow: 200000,
    defaultMaxTokens: 1024,
  });
  const pool = poolOf([capped]);
  const analysis = {
    summary: 'write code',
    complexity: 'specialist',
    requirements: [
      { capability: 'software.implementation', weight: 1, required: true, minOutputTokens: 32000 },
    ],
    source: 'model',
  };
  const ranked = rankModels(pool, taxonomy, analysis, {});
  assert.equal(ranked.candidates.length, 1, 'a deployment-chosen cap must not disqualify a model');
});
