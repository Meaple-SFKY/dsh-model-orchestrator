/**
 * Run artifacts: every unit's complete answer on disk, with an index.
 *
 * Why this exists. A run's result used to be the JSON document alone, and a
 * multi-unit run is easily larger than the harness will carry inline: the host's
 * spill policy replaces an oversized tool result with a bounded preview and a
 * locator, so the calling model was told the result "was stored somewhere" and
 * could not read a single unit's answer. The plugin cannot raise that ceiling — it
 * is the deployment's — but it CAN stop depending on it: each unit's full answer is
 * written to a real file, the result carries the path, and the inline copy is
 * bounded by the plugin on purpose rather than by whatever the host decides to cut.
 *
 * Where. Inside the calling session's working directory when one is known
 * (`<cwd>/.dsh-orchestrator/artifacts/<runId>/`), so the files sit with the work they
 * belong to; otherwise under the plugin's own state directory. Both are real paths in
 * the same process, and the result reports the absolute one either way.
 *
 * Failure is not a run failure. A read-only workspace, a full disk, a sandbox that
 * refuses the directory — each degrades to "this run has no artifacts", reported as
 * `artifacts.problems`, and the run still returns every unit result it produced.
 *
 * @module dsh-model-orchestrator/artifacts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { str } from './util.js';

/** Directory created inside a working directory to hold run artifacts. */
export const ARTIFACT_DIR_NAME = '.dsh-orchestrator';

/**
 * How much of a unit's answer is returned INLINE in the run result.
 *
 * Beyond this the inline `text` is elided and the file carries the rest. Chosen so
 * a run of several units stays well under a typical tool-result ceiling while still
 * showing the caller the substance of each answer without a second tool call.
 */
export const DEFAULT_INLINE_UNIT_CHARS = 4000;

/**
 * Make one path segment out of an arbitrary unit id.
 *
 * Unit ids are authored by a caller and can contain anything, so the segment is
 * reduced to a conservative character set rather than trusted as a path.
 *
 * @param text - the raw id.
 * @returns a safe, non-empty single segment.
 */
export function safeSegment(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return cleaned === '' ? 'unit' : cleaned.slice(0, 80);
}

/**
 * The calling agent's working directory, when it exposes one.
 *
 * The agent contract has carried `cwd` in several shapes across versions
 * (`agent.cwd`, session metadata, fork metadata), so each is probed rather than
 * assumed; an unreadable shape simply means the plugin's own directory is used.
 *
 * @param captain - the calling agent.
 * @returns the absolute path, or `undefined`.
 */
export function agentWorkingDirectory(captain) {
  const candidates = [
    captain?.cwd,
    captain?.meta?.cwd,
    captain?.session?.cwd,
    captain?.session?.meta?.cwd,
  ];
  for (const candidate of candidates) {
    const value = str(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Render the run index: one line per unit, with the file that holds its answer.
 *
 * Kept as Markdown because both a person and a model read it, and it is written
 * alongside the files it points at so a later session can find the run without the
 * tool result.
 *
 * @param info - `{ runId, task, startedAt, finishedAt, files, results }`.
 * @returns the index document.
 */
export function renderIndex(info) {
  const lines = [
    `# Orchestration run ${info.runId}`,
    '',
    `- started: ${new Date(info.startedAt).toISOString()}`,
    `- finished: ${new Date(info.finishedAt).toISOString()}`,
    `- elapsed: ${Math.max(0, info.finishedAt - info.startedAt)} ms`,
    `- units: ${info.results.length}`,
    '',
    '## Task',
    '',
    String(info.task ?? ''),
    '',
    '## Units',
    '',
    '| unit | capability | route | ok | bytes | file |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of info.results) {
    const file = info.files[result.id];
    lines.push(
      `| ${result.id} | ${result.capabilityId ?? ''} | ${result.route ?? '—'} | ${
        result.ok === true ? 'yes' : 'no'
      } | ${file?.bytes ?? 0} | ${file === undefined ? '—' : file.name} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render one unit's artifact: its answer, plus the routing facts that produced it.
 *
 * @param result - the unit result.
 * @returns the file content.
 */
export function renderUnit(result) {
  const lines = [
    `# ${result.capabilityLabel ?? result.capabilityId ?? result.id}`,
    '',
    `- unit: ${result.id}`,
    `- capability: ${result.capabilityId ?? '—'}`,
    `- route: ${result.route ?? '—'}`,
    `- outcome: ${result.ok === true ? 'completed' : `failed (${result.stopReason ?? result.error ?? 'unknown'})`}`,
  ];
  if (result.routeReason !== undefined) lines.push(`- why this route: ${result.routeReason}`);
  if (result.dependsOn?.length > 0) lines.push(`- depends on: ${result.dependsOn.join(', ')}`);
  if (Number.isSafeInteger(result.elapsedMs)) lines.push(`- took: ${result.elapsedMs} ms`);
  lines.push('', '## Answer', '', String(result.text ?? ''));
  if (result.ok !== true && result.error !== undefined) {
    lines.push('', '## Error', '', String(result.error));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the run-artifact writer.
 *
 * @param options - `{ logger, fallbackDir, now }`, where `fallbackDir` is used when
 *   the calling agent exposes no working directory.
 * @returns `{ enabled, writeRun }`.
 */
export function createArtifactWriter({ logger, fallbackDir, now = () => Date.now() } = {}) {
  /**
   * Write every unit's answer and an index for one run.
   *
   * Never throws: a filesystem failure becomes a reported problem and the run
   * proceeds without artifacts.
   *
   * @param info - `{ runId, task, startedAt, finishedAt, results, captain }`.
   * @returns `{ dir, index, files, problems }` — `dir` is `undefined` when nothing landed.
   */
  function writeRun(info) {
    const problems = [];
    const results = Array.isArray(info?.results) ? info.results : [];
    if (results.length === 0) return { files: {}, problems };

    const working = agentWorkingDirectory(info?.captain);
    const base = working === undefined ? fallbackDir : join(working, ARTIFACT_DIR_NAME, 'artifacts');
    if (base === undefined) {
      return { files: {}, problems: ['no working directory and no state directory to hold artifacts'] };
    }
    const dir = join(base, safeSegment(info.runId));
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { files: {}, problems: [`could not create ${dir}: ${String(error?.message ?? error)}`] };
    }

    const files = {};
    for (const result of results) {
      const name = `${safeSegment(result.id)}.md`;
      const path = join(dir, name);
      const body = renderUnit(result);
      try {
        writeFileSync(path, body, 'utf8');
        files[result.id] = {
          name,
          path,
          bytes: Buffer.byteLength(body, 'utf8'),
        };
      } catch (error) {
        // One unit's file failing must not lose the others.
        problems.push(`could not write ${path}: ${String(error?.message ?? error)}`);
      }
    }

    let indexPath;
    try {
      indexPath = join(dir, 'index.md');
      writeFileSync(
        indexPath,
        renderIndex({ ...info, files, now: now() }),
        'utf8',
      );
    } catch (error) {
      indexPath = undefined;
      problems.push(`could not write the index in ${dir}: ${String(error?.message ?? error)}`);
    }

    if (problems.length > 0) {
      logger?.warn?.(`orchestrator: artifacts degraded for run ${info?.runId}: ${problems.join('; ')}`);
    }
    return {
      ...(indexPath === undefined ? {} : { index: indexPath }),
      dir,
      files,
      problems,
    };
  }

  return { writeRun };
}

/**
 * Bound an inline answer, saying how much was elided and where the rest is.
 *
 * @param text - the full answer.
 * @param path - the artifact path, when one exists.
 * @param limit - the inline character budget.
 * @returns `{ text, truncated, elidedChars }`.
 */
export function boundInline(text, path, limit = DEFAULT_INLINE_UNIT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return { text: value, truncated: false, elidedChars: 0 };
  const elidedChars = value.length - limit;
  // When no file was written, say so plainly rather than pointing at nothing: an elided
  // answer with no location is worse than an honest "it is gone".
  const where =
    path === undefined
      ? 'the rest was not persisted; re-run the unit if you need it'
      : `read the full answer at ${path}`;
  return {
    text: `${value.slice(0, limit)}\n\n… [${elidedChars} character(s) elided; ${where}]`,
    truncated: true,
    elidedChars,
  };
}
