/**
 * Locating, and materializing, the installed DSH tree.
 *
 * Two suites had their own verbatim copy of `findDshInstall` and one had
 * `materialize`, and `compatibility.test.js` needed both — which is why three of
 * its checks skipped instead of running. One shared copy, used by all three.
 *
 * Materializing is what lets a bare checkout exercise the REAL host contract: a
 * copy of `lib/` beside a symlink to the host's `node_modules` resolves
 * `@deepseek-ai/*` exactly as an installed plugin does, which is the whole point
 * of the exercise.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The repository root, derived from this helper's own location. */
export const ROOT = dirname(dirname(dirname(new URL(import.meta.url).pathname)));

export function findDshInstall() {
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


export async function materialize(install, name, options = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'orch-exec-'));
  const lib = join(scratch, 'lib');
  mkdirSync(lib, { recursive: true });
  for (const entry of readdirSync(join(ROOT, 'lib'))) {
    if (entry.endsWith('.js')) copyFileSync(join(ROOT, 'lib', entry), join(lib, entry));
  }
  const hostModules = join(install, 'node_modules');
  const hostScoped = join(hostModules, '@deepseek-ai');
  if (!existsSync(join(hostScoped, 'dsh-tools'))) {
    throw new Error(`the DSH install at ${install} has no host packages to link against`);
  }
  // The copied modules use ESM syntax, and a scratch directory has no manifest
  // of its own. Declaring the type explicitly keeps the test from depending on
  // whatever the nearest ancestor package.json happens to say — and a caller that
  // exercises the compatibility gate needs the REAL manifest, because a scratch
  // one without `engines.dsh` would make the gate refuse the host it is testing.
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify(
      options.manifest === undefined
        ? { name: 'orch-scratch', private: true, type: 'module' }
        : { ...options.manifest, private: true, type: 'module' },
    ),
  );
  // A SYNTHETIC node_modules, not a symlink to the host's: the CLI package
  // `@deepseek-ai/dsh` lives in the Node installation's own node_modules, one level
  // ABOVE the install's, while the sub-packages live inside it. Linking only
  // `install/node_modules` therefore resolved `@deepseek-ai/dsh-tools` but never
  // `@deepseek-ai/dsh` — which is exactly the package the compatibility gate
  // resolves the running version from, so those checks could only skip.
  const scratchModules = join(scratch, 'node_modules');
  const scratchScoped = join(scratchModules, '@deepseek-ai');
  mkdirSync(scratchScoped, { recursive: true });
  symlinkSync(install, join(scratchScoped, 'dsh'), 'dir');
  for (const entry of readdirSync(hostScoped)) {
    const target = join(scratchScoped, entry);
    if (existsSync(target)) continue;
    // `dsh` is already linked to the install itself.
    symlinkSync(join(hostScoped, entry), target, 'dir');
  }
  return {
    module: await import(pathToFileURL(join(lib, name)).href),
    scratch,
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  };
}
