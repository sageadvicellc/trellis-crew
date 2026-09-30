import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../../src/adapters/types.ts';
import type { CliDeps } from '../../src/cli.ts';
import type { Env } from '../../src/env.ts';
import { writeInstallRecord } from '../../src/store/install-yml.ts';
import { makeTestEnv } from './env.ts';
import { makeFixtureRepo, type FixtureRepo } from './git-repo.ts';
import { gitRunner, type GitRunner } from './git-runner.ts';
import { capture, type Capture } from './io.ts';
import { recordingRunner, type RecordingRunner } from './recording-runner.ts';

export interface Harnessed {
  env: Env;
  runner: RecordingRunner;
  out: Capture;
  err: Capture;
  deps: CliDeps;
}

/** A fixture home with Claude Code chosen at install, and a recording runner. */
export function claudeInstalled(extra: Partial<CliDeps> = {}): Harnessed {
  return installedOn('claude-code', 'native', extra);
}

/**
 * A fixture home with a harness and transport chosen at install, and a
 * recording runner. On Codex CLI the current folder is the top of a fresh
 * temp git repository, because Codex sessions start only there.
 */
export function installedOn(
  harness: Adapter['id'],
  transport: 'native' | 'a2a' | 'file-mailbox',
  extra: Partial<CliDeps> = {},
): Harnessed {
  const env = harness === 'codex' ? makeTestEnv({ cwd: makeFixtureRepo().root }) : makeTestEnv();
  writeInstallRecord(env, { harness, transport, plugin_version: '0.1.0' });
  const runner = recordingRunner();
  const out = capture();
  const err = capture();
  return { env, runner, out, err, deps: { env, runner, out: out.write, err: err.write, ...extra } };
}

export interface HarnessedRepo extends Omit<Harnessed, 'runner'> {
  runner: GitRunner;
  repo: FixtureRepo;
}

/**
 * Like installedOn, but the Env's current folder is the top of a fresh git
 * repository apart from the home, and the runner runs git for real. The
 * Codex skill export needs both.
 */
export function installedInRepo(
  harness: Adapter['id'],
  transport: 'native' | 'a2a' | 'file-mailbox',
  extra: Partial<CliDeps> = {},
): HarnessedRepo {
  const repo = makeFixtureRepo();
  const env = makeTestEnv({ cwd: repo.root });
  writeInstallRecord(env, { harness, transport, plugin_version: '0.1.0' });
  const runner = gitRunner();
  const out = capture();
  const err = capture();
  return { env, runner, repo, out, err, deps: { env, runner, out: out.write, err: err.write, ...extra } };
}

/** Writes a roles file into the Env's current folder and returns its path. */
export function writeRoles(env: Env, name: string, text: string): string {
  const path = join(env.cwd, name);
  writeFileSync(path, text);
  return path;
}

/**
 * A stand-in adapter that starts each session as a detached process, so
 * tests can exercise the pid paths that a later harness step fills in.
 */
export function detachedAdapter(id: Adapter['id'] = 'qwen-code', flags: Adapter['flags'] = {}): Adapter {
  return {
    id,
    displayName: 'Fixture Harness',
    flags,
    async launch(name, kickoff, flagArgs, ctx) {
      const { pid } = await ctx.runner.spawnDetached(ctx.binaryPath, [...flagArgs, kickoff]);
      return { ok: true, entry: { name, pid, session_id: `fixture-${name}-${pid}` } };
    },
    noProcessNote: (entry) => `${entry.name}: fixture note`,
  };
}
