/**
 * Harness-home resolution.
 *
 * The orchestrator stores its preferences under the harness home. The home is
 * resolved in the same order the harness itself uses, and the semantic
 * `DSH_HOME` shell variable always wins so a relocated home is honoured.
 *
 * @module dsh-model-orchestrator/home
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { str } from './util.js';

/**
 * Resolve the harness home directory.
 *
 * Precedence: an explicit `DSH_HOME`, then the environment's `DSH_HOME`, then
 * `~/.dsh`. The bound `dshHomePath` helper the host exposes is used only to
 * discover the base directory, never to build the state path, so a deployment
 * that relocates the home is still honoured.
 *
 * @param ctx - the plugin context (may expose `dshHomePath`).
 * @returns the absolute harness home path.
 */
export function resolveDshHome(ctx) {
  const explicit = str(process.env.DSH_HOME);
  if (explicit !== undefined) return explicit;

  const fromHost = str(ctx?.get?.('dshHomePath')?.());
  if (fromHost !== undefined) return fromHost;

  return join(homedir(), '.dsh');
}

