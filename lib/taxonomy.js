/**
 * The open capability taxonomy.
 *
 * A "capability" is a generic descriptor of what a unit of work needs. It is
 * deliberately NOT a domain→model table: no model id, provider, or vendor name
 * appears anywhere in this file, and nothing maps a capability to a fixed
 * model. Capabilities are matched against *evidence observed at runtime* from
 * the live pool (see `capabilities.js`).
 *
 * The key space is open. The seeds below cover common families — software, data,
 * research, writing, math, science, multimodal, documents, web, engineering
 * analysis — as a starting vocabulary, and `synthesizeCapability` mints a new
 * descriptor for a domain the taxonomy has never seen. Callers may register
 * their own descriptors at runtime.
 *
 * @module dsh-model-orchestrator/taxonomy
 */
import { str, uniqueStrings } from './util.js';

/**
 * Evidence primitives. Each names an observation the host can actually make
 * about a model. A descriptor is a set of requirements over these.
 *
 * @typedef {object} Signal
 * @property {'modality'} [type]
 * @property {'image'|'text'} [modality]
 * @property {number} [min]      // context window / output token floor
 * @property {number} [max]      // context window / output token ceiling
 * @property {boolean} [required] // hard requirement instead of a preference
 * @property {string[]} [efforts] // reasoning effort ids that must be available
 * @property {string[]} [keywords] // tokens matched against declared text
 * @property {number} [weight]    // preference strength, default 1
 */

const MODALITIES = Object.freeze(['text', 'image']);

/**
 * Build a signal. Exported so callers can compose descriptors without
 * remembering the exact field spelling.
 * @param {object} spec - signal fields.
 * @returns {Signal} a frozen signal.
 */
export function signal(spec) {
  const out = {};
  if (spec.type !== undefined) out.type = spec.type;
  if (spec.modality !== undefined) out.modality = spec.modality;
  if (spec.min !== undefined) out.min = spec.min;
  if (spec.max !== undefined) out.max = spec.max;
  if (spec.required !== undefined) out.required = spec.required;
  if (spec.efforts !== undefined) out.efforts = uniqueStrings(spec.efforts);
  if (spec.keywords !== undefined) out.keywords = uniqueStrings(spec.keywords);
  out.weight = typeof spec.weight === 'number' ? spec.weight : 1;
  return Object.freeze(out);
}

/** Convenience: an image-input requirement. */
export const needsImage = () => signal({ type: 'modality', modality: 'image', required: true });
/** Convenience: a context-window floor. */
export const needsContext = (min, required = false) =>
  signal({ type: 'contextAtLeast', min, required });
/** Convenience: an output-token floor. */
export const needsOutput = (min, required = false) =>
  signal({ type: 'outputAtLeast', min, required });
/** Convenience: keyword evidence over declared model text. */
export const matches = (keywords, weight = 1) => signal({ type: 'keywords', keywords, weight });
/** Convenience: a reasoning-effort requirement. */
export const needsReasoning = (efforts = [], required = false) =>
  signal({ type: 'reasoning', efforts, required });

/**
 * A capability descriptor.
 *
 * @typedef {object} CapabilityDescriptor
 * @property {string} id
 * @property {string} label
 * @property {string} group
 * @property {string} [summary]
 * @property {Signal[]} signals
 * @property {Signal[]} [antiSignals]
 * @property {'seed'|'synthesized'|'custom'} [origin]
 */

/**
 * The seed taxonomy. Generic, cross-domain, and model-agnostic by construction.
 *
 * Keyword lists are intentionally broad and bilingual (English + Chinese) so a
 * task phrased in either language resolves to the same descriptors. They are
 * *vocabulary*, not routing: keywords only produce soft evidence about a model's
 * declared self-description, and every one of them can be overridden.
 *
 * @type {readonly CapabilityDescriptor[]}
 */
export const SEED_CAPABILITIES = Object.freeze([
  {
    id: 'software.implementation',
    label: 'Software implementation',
    group: 'software',
    summary: 'Write, modify, and refactor code and configuration in a real repository.',
    signals: [
      matches(['coder', 'coding', 'code', 'program', 'software', 'engineer', 'implementation', '代码', '编程', '工程'], 1.2),
      needsOutput(4096),
    ],
  },
  {
    id: 'software.debugging',
    label: 'Debugging and diagnosis',
    group: 'software',
    summary: 'Find root causes of failures from symptoms, logs, and stack traces.',
    signals: [
      matches(['debug', 'diagnos', 'root cause', 'troubleshoot', 'trace', '调试', '排查', '定位'], 1.2),
    ],
  },
  {
    id: 'software.architecture',
    label: 'Architecture and design',
    group: 'software',
    summary: 'Design system structure, interfaces, and trade-offs before code exists.',
    signals: [
      matches(['architect', 'design', 'interfaces', 'trade-off', 'tradeoff', '架构', '设计'], 1),
      needsReasoning([], false),
    ],
  },
  {
    id: 'software.review',
    label: 'Code review and verification',
    group: 'software',
    summary: 'Adversarially inspect a change for correctness and risk.',
    signals: [matches(['review', 'audit', 'verify', 'critique', '审查', '评审', '复核'], 1.1)],
  },
  {
    id: 'software.testing',
    label: 'Testing and verification',
    group: 'software',
    summary: 'Design and run tests, reproduce defects, and prove behavior.',
    signals: [matches(['test', 'spec', 'coverage', 'reproduce', '测试', '验证'], 1)],
  },
  {
    id: 'software.operations',
    label: 'Build, deploy, and operations',
    group: 'software',
    summary: 'Operate build systems, pipelines, packaging, and release tooling.',
    signals: [matches(['build', 'deploy', 'ci', 'pipeline', 'release', 'packaging', '构建', '部署', '发布'], 1)],
  },
  {
    id: 'data.analysis',
    label: 'Data analysis',
    group: 'data',
    summary: 'Explore, clean, aggregate, and reason about datasets.',
    signals: [matches(['data', 'dataset', 'analytics', 'sql', 'aggregate', 'pandas', '数据', '分析', '统计'], 1.2)],
  },
  {
    id: 'data.visualization',
    label: 'Data visualization',
    group: 'data',
    summary: 'Turn data into charts and readable visual summaries.',
    signals: [matches(['chart', 'plot', 'visualis', 'visualiz', 'dashboard', '图表', '可视化'], 1.1)],
  },
  {
    id: 'data.statistics',
    label: 'Statistics and inference',
    group: 'data',
    summary: 'Statistical modelling, hypothesis testing, and uncertainty.',
    signals: [matches(['statistic', 'bayes', 'regression', 'significance', 'probability', '概率', '显著性'], 1.2)],
  },
  {
    id: 'reasoning.general',
    label: 'Difficult general reasoning',
    group: 'reasoning',
    summary: 'Multi-step deduction and planning where mistakes compound.',
    signals: [needsReasoning([], false), matches(['reason', 'think', 'plan', '逻辑', '推理', '规划'], 1)],
  },
  {
    id: 'reasoning.mathematics',
    label: 'Mathematics',
    group: 'reasoning',
    summary: 'Symbolic and numeric mathematics, derivations, and formal argument.',
    signals: [matches(['math', 'algebra', 'calculus', 'proof', 'theorem', 'equation', '数学', '证明', '方程'], 1.2)],
  },
  {
    id: 'science.technical',
    label: 'Science and engineering analysis',
    group: 'science',
    summary: 'Physical-science and engineering reasoning over models and measurements.',
    signals: [
      matches(['physics', 'chemistry', 'biology', 'engineering', 'simulation', 'mechanics', 'signal', 'control', '物理', '化学', '工程', '仿真'], 1.2),
    ],
  },
  {
    id: 'research.investigation',
    label: 'Research and investigation',
    group: 'research',
    summary: 'Gather, compare, and synthesize many sources into a defensible answer.',
    signals: [
      matches(['research', 'investigate', 'survey', 'literature', 'compare sources', '研究', '调研', '综述'], 1.2),
      needsContext(32000),
    ],
  },
  {
    id: 'web.information',
    label: 'Web information retrieval',
    group: 'web',
    summary: 'Find, read, and reconcile information from the public web.',
    signals: [matches(['web', 'search', 'browse', 'fetch', 'online', 'internet', '网页', '检索', '搜索'], 1.1)],
  },
  {
    id: 'document.processing',
    label: 'Document processing',
    group: 'document',
    summary: 'Read, extract, restructure, and generate long-form documents.',
    signals: [
      matches(['document', 'pdf', 'docx', 'markdown', 'extract', 'report', '文档', '报告', '提取'], 1.1),
      needsContext(32000),
    ],
  },
  {
    id: 'writing.production',
    label: 'Writing and editing',
    group: 'writing',
    summary: 'Produce and refine prose for a stated audience and purpose.',
    signals: [matches(['write', 'writing', 'edit', 'prose', 'copy', 'draft', '写作', '编辑', '文案'], 1.1)],
  },
  {
    id: 'writing.translation',
    label: 'Translation and localization',
    group: 'writing',
    summary: 'Translate between natural languages while preserving intent and register.',
    signals: [matches(['translat', 'localis', 'localiz', 'bilingual', '翻译', '本地化'], 1.2)],
  },
  {
    id: 'multimodal.vision',
    label: 'Image understanding',
    group: 'multimodal',
    summary: 'Read and reason about images supplied as input.',
    signals: [needsImage()],
  },
  {
    id: 'multimodal.screenshot',
    label: 'Screenshot and UI reading',
    group: 'multimodal',
    summary: 'Interpret screenshots, UI states, and diagrams.',
    signals: [needsImage(), matches(['screenshot', 'ui', 'diagram', 'figure', '截图', '界面', '图'], 0.7)],
  },
  {
    id: 'long.context',
    label: 'Very long context',
    group: 'context',
    summary: 'Hold and reason over a large body of material at once.',
    signals: [needsContext(128000, true), needsOutput(8192)],
  },
  {
    id: 'throughput.bulk',
    label: 'High-volume routine work',
    group: 'throughput',
    summary: 'Many independent, well-specified units where speed and cost dominate.',
    signals: [
      // Bulk work wants the opposite of depth: no reasoning premium.
      signal({ type: 'reasoning', max: 0, weight: 0.5 }),
      matches(['bulk', 'batch', 'routine', 'many files', '批量', '并行'], 1),
    ],
  },

  // ---- capability LEVEL ----------------------------------------------------
  // These descriptors are deliberately domain-free. They express *how much*
  // capability a unit of work needs, and they are matched against facts the host
  // measures (context window, exposed reasoning efforts) rather than against a
  // model's marketing prose. This is what makes routing work for a domain no
  // model has ever described itself as covering.

  {
    id: 'depth.difficult',
    label: 'Difficult, compounding reasoning',
    group: 'depth',
    summary:
      'Multi-step work where an early mistake is expensive: proofs, root-cause analysis, non-obvious design, adversarial review.',
    signals: [
      // `required` means a route with no reasoning effort exposed is rejected
      // outright instead of being expected to answer above its weight.
      needsReasoning([], true),
      needsContext(32000, false),
    ],
  },
  {
    id: 'depth.routine',
    label: 'Routine, well-specified work',
    group: 'depth',
    summary: 'Mechanical edits, formatting, extraction, and clearly specified single steps.',
    signals: [
      // The inverse preference: a model that does not expose a reasoning
      // premium is a better (faster, cheaper) fit for mechanical work.
      signal({ type: 'reasoning', max: 0, weight: 1 }),
      needsContext(1000, false),
    ],
  },
  {
    id: 'capacity.very_long',
    label: 'Very large input',
    group: 'capacity',
    summary: 'Work that must hold a large body of material in view at once.',
    signals: [needsContext(128000, true), needsOutput(8192)],
  },
]);

/** Index seeds by id for O(1) lookup. */
const SEED_BY_ID = new Map(SEED_CAPABILITIES.map((entry) => [entry.id, entry]));

/**
 * Validate and normalize a descriptor supplied by a caller or synthesized.
 *
 * @param input - a candidate descriptor.
 * @returns a normalized descriptor.
 * @throws when the descriptor is unusable.
 */
export function normalizeDescriptor(input) {
  if (typeof input !== 'object' || input === null) {
    throw new Error('capability descriptor must be an object');
  }
  const id = str(input.id);
  if (id === undefined) throw new Error('capability descriptor needs a non-empty "id"');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`capability id "${id}" must match [a-z0-9][a-z0-9._-]*`);
  }
  const label = str(input.label) ?? id;
  const group = str(input.group) ?? id.split('.')[0] ?? 'general';
  const signals = Array.isArray(input.signals) ? input.signals.map((s) => signal(s ?? {})) : [];
  if (signals.length === 0) {
    throw new Error(`capability "${id}" must declare at least one signal`);
  }
  const antiSignals = Array.isArray(input.antiSignals)
    ? input.antiSignals.map((s) => signal(s ?? {}))
    : [];
  const origin = ['seed', 'synthesized', 'custom'].includes(input.origin) ? input.origin : 'custom';
  return Object.freeze({
    id,
    label,
    group,
    ...(str(input.summary) === undefined ? {} : { summary: str(input.summary) }),
    signals: Object.freeze(signals),
    antiSignals: Object.freeze(antiSignals),
    origin,
  });
}

/** Normalize a whole seed list once. */
const NORMALIZED_SEEDS = Object.freeze(SEED_CAPABILITIES.map((entry) => normalizeDescriptor({ ...entry, origin: 'seed' })));

/**
 * The full descriptor set: seeds plus any caller-registered or synthesized
 * descriptors, keyed by id.
 */
export class Taxonomy {
  #descriptors = new Map(NORMALIZED_SEEDS.map((entry) => [entry.id, entry]));

  /** Every descriptor, seeds first in declaration order. */
  list() {
    return [...this.#descriptors.values()];
  }

  /** Look up one descriptor by id. */
  get(id) {
    return this.#descriptors.get(str(id) ?? '');
  }

  /** Whether an id is known. */
  has(id) {
    return this.#descriptors.has(str(id) ?? '');
  }

  /**
   * Register or replace a descriptor.
   * @param descriptor - candidate descriptor.
   * @returns the normalized descriptor.
   */
  register(descriptor) {
    const normalized = normalizeDescriptor(descriptor);
    this.#descriptors.set(normalized.id, normalized);
    return normalized;
  }

  /**
   * Add descriptors parsed from persisted state, ignoring unusable entries.
   * @param descriptors - persisted descriptors.
   * @returns how many were accepted.
   */
  restore(descriptors) {
    let accepted = 0;
    if (!Array.isArray(descriptors)) return accepted;
    for (const candidate of descriptors) {
      try {
        this.register(candidate);
        accepted += 1;
      } catch {
        // A descriptor that cannot be normalized is dropped rather than
        // poisoning activation; the taxonomy stays usable.
      }
    }
    return accepted;
  }

  /** Serialize only the non-seed descriptors, which are the ones worth keeping. */
  customDescriptors() {
    return this.list()
      .filter((entry) => entry.origin !== 'seed')
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        group: entry.group,
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        signals: entry.signals,
        ...(entry.antiSignals.length === 0 ? {} : { antiSignals: entry.antiSignals }),
        origin: entry.origin,
      }));
  }
}

/**
 * Mint a descriptor for a domain the taxonomy does not yet cover.
 *
 * This is how the capability system grows without a code change: an
 * unrecognized task yields a new generic descriptor derived from the task's own
 * vocabulary, which is then registered and persisted.
 *
 * @param spec - `{ label, group?, summary?, keywords, minContextWindow?,
 *   minOutputTokens?, needsReasoning?, needsImageInput? }`.
 * @returns the normalized descriptor.
 */
export function synthesizeCapability(spec) {
  const label = str(spec?.label) ?? 'Unclassified specialist work';
  const group = str(spec?.group) ?? 'synthesized';
  const idBase = `${group}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'synthesized';
  const labelSlug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'work';
  const id = `${idBase}.${labelSlug}`;

  const signals = [];
  const keywords = uniqueStrings(spec?.keywords ?? []);
  if (keywords.length > 0) signals.push(matches(keywords, 1.1));
  if (spec?.needsImageInput === true) signals.push(needsImage());
  if (Number.isSafeInteger(spec?.minContextWindow) && spec.minContextWindow > 0) {
    signals.push(needsContext(spec.minContextWindow, false));
  }
  if (Number.isSafeInteger(spec?.minOutputTokens) && spec.minOutputTokens > 0) {
    signals.push(needsOutput(spec.minOutputTokens, false));
  }
  if (spec?.needsReasoning === true) signals.push(needsReasoning([], false));
  if (signals.length === 0) signals.push(matches(keywords.length === 0 ? [label] : keywords, 1));

  return normalizeDescriptor({
    id,
    label,
    group,
    ...(str(spec?.summary) === undefined ? {} : { summary: str(spec.summary) }),
    signals,
    origin: 'synthesized',
  });
}

/** Every declared modality the taxonomy understands. */
export const KNOWN_MODALITIES = MODALITIES;

/** The seed id set, for diagnostics and tests. */
export const SEED_IDS = Object.freeze([...SEED_BY_ID.keys()]);
