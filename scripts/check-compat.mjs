#!/usr/bin/env node
/**
 * Standalone host-compatibility check.
 *
 * Runs the same gate the plugin runs at activation, without booting a session or
 * loading the plugin into a profile. Use it before installing, before releasing,
 * and in CI.
 *
 * Exit codes: 0 compatible, or nothing to check against; 1 incompatible; 2 the check
 * itself could not run — which includes `--strict` in a checkout with no DSH to check
 * against, so a gate can require a real answer.
 *
 * A BARE CHECKOUT IS NOT A FAILURE. The check used to report `RESULT: incompatible` and
 * exit 1 when it could not find a DSH installation, which is the normal state of a
 * fresh clone and of every CI runner — so the repository's own workflow failed on every
 * push, for a reason that had nothing to do with compatibility.
 *
 * @module dsh-model-orchestrator/scripts/check-compat
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaredDshRange,
  isExactVersion,
  loadSemver,
  matchesExactPrereleasePin,
  readOwnManifest,
  resolveHostVersions,
  satisfiesHost,
} from '../lib/compatibility.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Whether a missing host should fail the run. See the exit codes above. */
const STRICT = process.argv.includes('--strict') || process.argv.includes('--require-host');

/**
 * Locate the DSH installation visible to this checkout.
 *
 * Resolution from the package alone only works once the plugin is installed into
 * a profile. When run from a development checkout there is no host package tree
 * above this directory, so the installation is located explicitly: an ancestor
 * `node_modules`, the Node installation's own global `node_modules`, and any
 * profile under a harness home. `DSH_TEST_HOST` overrides the search.
 *
 * @returns the DSH package directory, or `undefined`.
 */
function findDshInstall() {
  const override = process.env.DSH_TEST_HOST;
  if (typeof override === 'string' && override !== '') return override;

  const candidates = [];
  let directory = ROOT;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(directory, 'node_modules', '@deepseek-ai', 'dsh'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const executable = process.execPath;
  if (typeof executable === 'string' && executable !== '') {
    const bin = dirname(executable);
    candidates.push(join(bin, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
    candidates.push(join(bin, 'node_modules', '@deepseek-ai', 'dsh'));
  }
  for (const home of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
    if (typeof home !== 'string' || home === '') continue;
    try {
      for (const entry of readdirSync(join(home, 'profiles'))) {
        candidates.push(join(home, 'profiles', entry, 'node_modules', '@deepseek-ai', 'dsh'));
      }
    } catch {
      // No profiles directory.
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/** A tiny reporter so the output is readable in a terminal and in CI logs. */
const report = {
  lines: [],
  ok(text) {
    this.lines.push(`  ok    ${text}`);
  },
  fail(text) {
    this.lines.push(`  FAIL  ${text}`);
  },
  skip(text) {
    this.lines.push(`  SKIP  ${text}`);
  },
  info(text) {
    this.lines.push(`  ...   ${text}`);
  },
  print() {
    process.stdout.write(`${this.lines.join('\n')}\n`);
  },
};

function main() {
  const manifest = readOwnManifest();
  report.lines.push(`${manifest.name} ${manifest.version} — host compatibility check`);
  report.lines.push('');

  let failed = false;
let verified = true;

  // ---- declared range ------------------------------------------------------
  const range = declaredDshRange(manifest);
  if (range === undefined) {
    report.fail('package.json declares no "engines.dsh" host range');
    failed = true;
  } else {
    report.ok(`declared host range: engines.dsh = "${range}"`);
  }

  const mirrored = manifest.dsh?.engines?.dsh;
  if (mirrored !== undefined && mirrored !== range) {
    report.fail(`dsh.engines.dsh ("${mirrored}") disagrees with engines.dsh ("${range}")`);
    failed = true;
  } else if (mirrored !== undefined) {
    report.ok(`dsh.engines.dsh mirrors it ("${mirrored}")`);
  } else {
    report.info('dsh.engines.dsh is not declared (optional mirror for marketplace discovery)');
  }

  // ---- running host --------------------------------------------------------
  // The package-relative resolution first (an installed plugin), then the
  // development-checkout search.
  let { host, anchors } = resolveHostVersions();
  if (host === undefined) {
    const install = findDshInstall();
    if (install !== undefined) {
      const resolved = resolveHostVersions(join(install, 'package.json'));
      host = resolved.host;
      anchors = { ...anchors, ...resolved.anchors };
    }
  }
  if (host === undefined) {
    // Nothing to compare against: no host is a condition of the machine, not a verdict
    // about this build. Reported plainly, and fatal only when the caller asked for a
    // real answer with `--strict`.
    verified = false;
    // Deliberately NOT `failed`: nothing was compared, so this is not a verdict about
    // the build. `--strict` only decides whether that unverified state is fatal.
    if (STRICT) {
      report.fail('no DSH installation is resolvable from this checkout; --strict requires one');
    } else {
      report.skip('no DSH installation is resolvable from this checkout; nothing was verified');
    }
  } else {
    report.ok(`running DSH: ${host.version}`);
  }
  for (const [anchor, entry] of Object.entries(anchors)) {
    if (anchor === '@deepseek-ai/dsh/package.json') continue;
    report.info(`peer reachable: ${anchor} = ${entry.version}`);
  }

  // ---- semver --------------------------------------------------------------
  const semver = loadSemver(host?.path);
  if (semver === undefined) {
    report.info('semver is not resolvable; only an exact version pin can be evaluated here');
    if (range !== undefined && !isExactVersion(range)) {
      report.fail(`range "${range}" cannot be evaluated without semver`);
      failed = true;
    }
  } else {
    report.ok('semver is available; full range evaluation enabled');
  }

  // ---- verdict -------------------------------------------------------------
  if (range !== undefined && host !== undefined) {
    if (satisfiesHost(semver, range, host.version)) {
      report.ok(`host ${host.version} satisfies "${range}"`);
    } else {
      const hint = matchesExactPrereleasePin(range, host.version)
        ? ' (the release core matches; the pinned prerelease does not)'
        : '';
      report.fail(`host ${host.version} does NOT satisfy "${range}"${hint}`);
      failed = true;
    }
  }

  // ---- peer declarations ---------------------------------------------------
  const peers = manifest.peerDependencies ?? {};
  const corePeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/'));
  if (corePeers.length === 0) {
    report.fail('no @deepseek-ai/* peerDependencies are declared');
    failed = true;
  } else {
    report.ok(`${corePeers.length} host package peer declaration(s)`);
  }

  // ---- compatibility.json --------------------------------------------------
  try {
    const compatibility = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'));
    if (compatibility.declaredRange !== range) {
      report.fail(
        `compatibility.json declaredRange ("${compatibility.declaredRange}") disagrees with engines.dsh ("${range}")`,
      );
      failed = true;
    } else {
      report.ok('compatibility.json agrees with the manifest');
    }
  } catch (error) {
    report.fail(`compatibility.json is missing or unreadable: ${String(error.message ?? error)}`);
    failed = true;
  }

  report.lines.push('');
  if (failed) {
    report.lines.push(
      `RESULT: incompatible. This build must not be activated against DSH ${host?.version ?? '(unknown)'}.`,
    );
  } else if (!verified) {
    report.lines.push(
      'RESULT: not verified — no DSH installation was found from this package. ' +
        (STRICT
          ? 'Install one where this runs, or drop --strict to treat that as a skip.'
          : 'Run this where a harness is installed, or pass --strict to make that fatal.'),
    );
  } else {
    report.lines.push(`RESULT: compatible with DSH ${host?.version ?? '(unknown)'}.`);
  }

  report.print();
  if (failed) return 1;
  if (!verified && STRICT) return 2;
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`compatibility check could not run: ${String(error?.stack ?? error)}\n`);
  process.exitCode = 2;
}
