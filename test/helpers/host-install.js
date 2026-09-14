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
  // `DSH_TEST_HOST=none` models a BARE CHECKOUT — the condition every host-dependent
  // check is supposed to skip in, and the one CI runs under. Without a way to say "there
  // is no harness here", that path could only be exercised by uninstalling DSH.
  if (override === 'none' || override === 'off') return undefined;
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
  // Reproduce the resolution the CLI itself performs, in the CLI's own order.
  //
  // npm's two layouts differ and both are normal: a global install HOISTS the CLI's
  // dependencies to the top level, while a version-manager install keeps them NESTED
  // inside the CLI. Node resolves nested first and the top level second, so the scratch
  // tree does the same — nested wins, the top level fills what it does not carry, and the
  // CLI itself is always linked. Assuming either layout alone made the suite pass on this
  // development machine and fail against a published install, which is how CI and every
  // other user would have it.
  const nested = join(install, 'node_modules', '@deepseek-ai');
  const topLevel = join(dirname(dirname(install)), '@deepseek-ai');
  if (!existsSync(nested) && !existsSync(topLevel)) {
    throw new Error(
      `the DSH install at ${install} has no host packages to link against (looked in ${nested} and ${topLevel})`,
    );
  }
  const scratchScoped = join(scratch, 'node_modules', '@deepseek-ai');
  mkdirSync(scratchScoped, { recursive: true });
  // The CLI package itself, which the compatibility gate reads its running version from
  // and which is never inside its own nested tree.
  symlinkSync(install, join(scratchScoped, 'dsh'), 'dir');
  for (const source of [nested, topLevel]) {
    if (!existsSync(source)) continue;
    for (const entry of readdirSync(source)) {
      const target = join(scratchScoped, entry);
      if (existsSync(target)) continue; // nested wins: it is what Node would pick
      symlinkSync(join(source, entry), target, 'dir');
    }
  }
  // The copied modules use ESM syntax, and a scratch directory has no manifest of its
  // own. Declaring the type explicitly keeps the tests from depending on whatever the
  // nearest ancestor package.json says — and a caller exercising the compatibility gate
  // passes its REAL manifest, because a scratch one without `engines.dsh` would make the
  // gate refuse the host it is testing.
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify(
      options.manifest === undefined
        ? { name: 'orch-scratch', private: true, type: 'module' }
        : { ...options.manifest, private: true, type: 'module' },
    ),
  );

  return {
    module: await import(pathToFileURL(join(lib, name)).href),
    scratch,
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  };
}
