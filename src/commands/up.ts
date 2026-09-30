import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { checkWorkdir } from '../adapters/codex-guard.ts';
import { adapterFor } from '../adapters/index.ts';
import type { Command, UpHarness } from '../args.ts';
import { codexExperimentalProblem } from '../experimental.ts';
import { mailboxPath } from '../mailbox/folder.ts';
import { EXIT_OK, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { HARNESSES } from '../detect/probe.ts';
import { printable } from '../printable.ts';
import { loadTeam, loadTeamText, type LoadResult } from '../roles/load.ts';
import { runInstall, type InstallHints, type InstallOptions } from './install.ts';
import { harnessMismatch, runStart } from './start.ts';

export type UpOptions = Omit<Extract<Command, { name: 'up' }>, 'name'>;

/** The lines install prints when it needs a flag or a command that `up` names differently. */
function upHints(harness: UpHarness): InstallHints {
  return {
    inboundMissing: 'Run up again with --accept-inbound to set it, or with --skip-inbound to leave it.',
    rolesNoTerminal: 'trellis-crew up asks no question about a roles file. Read it, then run up again with --yes.',
    recordDamaged: `Run trellis-crew install --reconfigure --harness ${harness} first, then run up again.`,
  };
}

/**
 * The install step of `up`, built as if `install --harness <name>
 * --non-interactive` had been given. `up --yes` confirms a roles file
 * only. It never consents to the inbound setting, which changes a user
 * settings file for every session of the harness. Only
 * `--accept-inbound` does that, as `install --yes` does. A transport that
 * install.yml records for the same harness is kept.
 */
export function upInstallOptions(options: UpOptions): InstallOptions {
  return {
    harness: options.harness,
    nonInteractive: true,
    reconfigure: false,
    yes: options.acceptInbound,
    skipInbound: options.skipInbound,
    rolesYes: options.yes,
    keepStoredTransport: true,
    hints: upHints(options.harness),
    ...(options.roles === undefined ? {} : { roles: options.roles }),
  };
}

const STEP_INSTALL = 'step 1 of 2, install';
const STEP_START = 'step 2 of 2, start';
const NOTHING_YET = 'Nothing was installed or started.';
const INSTALL_RAN = 'Nothing was started. The install step already ran.';

function stopped(deps: CliDeps, step: string, code: number, after: string): number {
  deps.err(`trellis-crew up stopped at ${step}, with exit code ${code}. ${after}`);
  return code;
}

/**
 * Reads a --roles file once. The last part of the path must not be a
 * symbolic link, which O_NOFOLLOW refuses, and the open file must be a
 * regular file. O_NONBLOCK keeps a named pipe from holding the read.
 * A parent folder can still be a link.
 */
function readRolesOnce(path: string): { ok: true; text: string } | { ok: false; reason: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ELOOP') return { ok: false, reason: 'the last part of the path is a symbolic link' };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, reason: 'not a regular file' };
    return { ok: true, text: readFileSync(fd, 'utf8') };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    closeSync(fd);
  }
}

function rolesPath(options: UpOptions, deps: CliDeps): string | undefined {
  if (options.roles === undefined) return undefined;
  return isAbsolute(options.roles) ? options.roles : resolve(deps.env.cwd, options.roles);
}

/** Prints why a --roles file cannot be read, and returns false. */
function readRoles(path: string, deps: CliDeps): { ok: true; text: string } | { ok: false } {
  const read = readRolesOnce(path);
  if (read.ok) return read;
  deps.err(`${printable(path)}: --roles must name a local regular file (${read.reason}).`);
  return { ok: false };
}

/**
 * Loads and checks the team before the install, with the loader that
 * start uses, the harness's bounds, and the harness check. So a bad or
 * mismatched roles file stops `up` before any install side effect.
 * Returns the SHA-256 of the text it read, or null for the default team.
 */
function checkTeam(options: UpOptions, deps: CliDeps): { ok: true; sha256: string | null } | { ok: false } {
  const common = { env: deps.env, harness: options.harness, ...(options.workers === undefined ? {} : { workers: options.workers }) };
  const path = rolesPath(options, deps);
  let loaded: LoadResult;
  if (path === undefined) {
    loaded = loadTeam(common);
  } else {
    const read = readRoles(path, deps);
    if (!read.ok) return { ok: false };
    loaded = loadTeamText(read.text, path, common);
  }
  if (!loaded.ok) {
    for (const line of loaded.lines) deps.err(line);
    return { ok: false };
  }
  const mismatch = harnessMismatch(loaded, options.harness);
  if (mismatch !== undefined) {
    deps.err(mismatch);
    return { ok: false };
  }
  // The same mailbox rule that start applies on this harness, before the install creates anything.
  if (loaded.config.transport !== 'a2a') {
    const problem = adapterFor(options.harness, deps.adapters)?.mailboxProblem?.(mailboxPath(loaded.config, deps.env), deps.env);
    if (problem !== undefined) {
      deps.err(problem);
      return { ok: false };
    }
  }
  // The loader hashes the text it validated, which for --roles is the text read once.
  return { ok: true, sha256: loaded.sha256 };
}

function displayName(harness: UpHarness): string {
  return HARNESSES.find((h) => h.id === harness)?.displayName ?? harness;
}

/**
 * Installs the named harness with no question, then starts the team, in
 * one step. It checks the team first. It stops at the first step that
 * fails, names that step, and exits with that step's code.
 */
export async function runUp(options: UpOptions, deps: CliDeps): Promise<number> {
  if (options.harness === 'codex') {
    // Codex is behind an experimental flag in this version. Nothing runs or is written before this.
    const experimental = codexExperimentalProblem(deps.env.vars);
    if (experimental !== undefined) {
      deps.err(experimental);
      return stopped(deps, STEP_INSTALL, EXIT_USAGE, NOTHING_YET);
    }
    // Codex sessions can write their working folder, so it is checked before anything else.
    const workdir = await checkWorkdir(deps.env, deps.runner);
    if (workdir !== undefined) {
      deps.err(workdir);
      return stopped(deps, STEP_INSTALL, EXIT_USAGE, NOTHING_YET);
    }
  }
  const checked = checkTeam(options, deps);
  if (!checked.ok) return stopped(deps, STEP_INSTALL, EXIT_USAGE, NOTHING_YET);

  deps.out(`Step 1 of 2: install on ${displayName(options.harness)}, with no questions.`);
  const installed = await runInstall(upInstallOptions(options), deps);
  if (installed !== EXIT_OK) return stopped(deps, STEP_INSTALL, installed, 'Nothing was started.');

  // The install step took time, so the file is checked again before start reads it.
  const path = rolesPath(options, deps);
  if (path !== undefined && !readRoles(path, deps).ok) return stopped(deps, STEP_START, EXIT_USAGE, INSTALL_RAN);
  deps.out('Step 2 of 2: start the team.');
  const started = await runStart(
    {
      harness: options.harness,
      yes: options.yes,
      expectSha256: checked.sha256,
      ...(options.roles === undefined ? {} : { roles: options.roles }),
      ...(options.workers === undefined ? {} : { workers: options.workers }),
    },
    deps,
  );
  if (started !== EXIT_OK) return stopped(deps, STEP_START, started, 'The install step already ran.');
  return started;
}
