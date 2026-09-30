import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { codexExecArgs } from '../src/adapters/codex-args.ts';
import { runSupervisor, type SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { supervisorScriptPath } from '../src/adapters/codex.ts';
import { readTeamFile, writeTeamFile } from '../src/store/team-json.ts';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.ts';
import type { Adapter } from '../src/adapters/types.ts';
import { main, type CliDeps } from '../src/cli.ts';
import type { HarnessId } from '../src/roles/schema.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { CODEX_EXPERIMENTAL_MESSAGE, codexExperimentalProblem } from '../src/experimental.ts';
import { installYmlPath, readInstallRecord } from '../src/store/install-yml.ts';
import { readTeam, teamJsonPath, writeTeam } from '../src/store/team-json.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { fixtureBin } from './helpers/paths.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { recordingRunner } from './helpers/recording-runner.ts';
import { installedOn, type Harnessed } from './helpers/team.ts';

const VARIABLE = 'TRELLIS_EXPERIMENTAL_CODEX';
const MESSAGE = 'Codex CLI support is experimental in this version and arrives in v1. Set TRELLIS_EXPERIMENTAL_CODEX=1 to try it.';

/** The same rig, with the flag variable set to `value`, or absent when undefined. */
function withFlag(t: Harnessed, value: string | undefined): Harnessed {
  const vars: Record<string, string | undefined> = { HOME: t.env.home, PATH: t.env.path };
  if (value !== undefined) vars[VARIABLE] = value;
  const env = { ...t.env, vars };
  return { ...t, env, deps: { ...t.deps, env } };
}

const OFF = undefined;
const ON = '1';

/** No runner call of any kind, and no file written under the state folder. */
function expectNothingHappened(t: Harnessed): void {
  expect(t.runner.calls).toEqual([]);
  expect(existsSync(teamJsonPath(t.env))).toBe(false);
  expect(existsSync(join(t.env.home, '.agents'))).toBe(false);
}

describe('codexExperimentalProblem', () => {
  it('allows Codex only for the exact value 1', () => {
    expect(codexExperimentalProblem({ [VARIABLE]: '1' })).toBeUndefined();
  });

  it('refuses when unset, empty, 0, true, or 1 with a space, and says Codex arrives in v1', () => {
    for (const value of [undefined, '', '0', 'true', ' 1', '1 ', '01', 'yes', 'TRUE']) {
      expect(codexExperimentalProblem({ [VARIABLE]: value })).toBe(MESSAGE);
    }
    expect(codexExperimentalProblem({})).toBe(MESSAGE);
    expect(CODEX_EXPERIMENTAL_MESSAGE).toBe(MESSAGE);
    expect(MESSAGE).toContain('arrives in v1');
  });

  it('is not fooled by another variable', () => {
    expect(codexExperimentalProblem({ TRELLIS_EXPERIMENTAL: '1', CODEX: '1' })).toBe(MESSAGE);
  });
});

describe('up --harness codex, flag off', () => {
  it('refuses with exit 2 and the message, before any runner call or file write', async () => {
    for (const value of [OFF, '', '0', 'true', ' 1']) {
      // A fresh home with no record, so any write would show.
      const env = makeTestEnv({ cwd: makeFixtureRepo().root });
      const runner = recordingRunner();
      const out = capture();
      const err = capture();
      const fresh = withFlag({ env, runner, out, err, deps: { env, runner, out: out.write, err: err.write } }, value);
      expect(await main(['up', '--harness', 'codex'], fresh.deps)).toBe(2);
      expect(fresh.err.text()).toContain(MESSAGE);
      expect(fresh.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 2. Nothing was installed or started.');
      expect(fresh.out.text()).not.toContain('Step 1 of 2');
      expect(fresh.runner.calls).toEqual([]);
      expect(existsSync(join(fresh.env.home, '.trellis-crew'))).toBe(false);
      expect(existsSync(join(fresh.env.home, '.agents'))).toBe(false);
    }
  });
});

describe('up --harness codex, flag on', () => {
  it('reaches the existing worktree-top refusal, unchanged', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), ON);
    mkdirSync(join(t.env.cwd, 'sub'));
    const deps: CliDeps = { ...t.deps, env: { ...t.env, cwd: join(t.env.cwd, 'sub') } };
    expect(await main(['up', '--harness', 'codex', '--yes'], deps)).toBe(2);
    expect(t.err.text()).not.toContain(MESSAGE);
    expect(t.err.text()).toContain('Codex CLI sessions can write their working folder, so trellis-crew starts them only at the top of a git worktree.');
    expect(t.err.text()).toMatch(/: it is not the top of a git worktree\. The top is /);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 2. Nothing was installed or started.');
  });

  it('installs and starts at the top of a worktree, as before', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['up', '--harness', 'codex', '--yes'], t.deps)).toBe(0);
    expect(t.err.text()).not.toContain(MESSAGE);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toHaveLength(1);
  });
});

describe('every other way Codex is chosen or started, flag off and on', () => {
  it('install --harness codex', async () => {
    const off = withFlag(installedOn('claude-code', 'native'), OFF);
    const before = readFileSync(installYmlPath(off.env), 'utf8');
    expect(await main(['install', '--harness', 'codex', '--non-interactive'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expect(off.runner.calls).toEqual([]);
    // Nothing about Codex is printed before the refusal, not even "Using Codex CLI".
    expect(off.out.text()).toBe('');
    expect(readFileSync(installYmlPath(off.env), 'utf8')).toBe(before);
    expect(existsSync(join(off.env.home, '.agents'))).toBe(false);

    const on = withFlag(installedOn('claude-code', 'native'), ON);
    expect(await main(['install', '--harness', 'codex', '--non-interactive'], on.deps)).toBe(0);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(readInstallRecord(on.env)).toMatchObject({ ok: true, record: { harness: 'codex' } });
  });

  it('install with no --harness, when install.yml records codex', async () => {
    const off = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    const before = readFileSync(installYmlPath(off.env), 'utf8');
    expect(await main(['install'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expect(off.runner.calls).toEqual([]);
    expect(off.out.text()).toBe('');
    expect(readFileSync(installYmlPath(off.env), 'utf8')).toBe(before);

    const on = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['install'], on.deps)).toBe(0);
    expect(on.err.text()).not.toContain(MESSAGE);
  });

  it('install that detects only Codex on PATH', async () => {
    const bin = makeFixtureHome();
    const only = join(bin, 'only-codex');
    mkdirSync(only);
    copyFileSync(join(fixtureBin, 'codex'), join(only, 'codex'));
    const env = makeTestEnv({ path: only });
    const runner = recordingRunner();
    const out = capture();
    const err = capture();
    const off = { ...env, vars: { HOME: env.home, PATH: only } };
    expect(await main(['install', '--non-interactive'], { env: off, runner, out: out.write, err: err.write })).toBe(2);
    expect(err.text()).toContain(MESSAGE);
    expect(existsSync(installYmlPath(off))).toBe(false);
    expect(existsSync(join(off.home, '.agents'))).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it('install that detects Claude Code and Codex, flag off: codex --version never runs, and Claude Code probes as before', async () => {
    const pathDir = join(makeFixtureHome(), 'both');
    mkdirSync(pathDir);
    copyFileSync(join(fixtureBin, 'codex'), join(pathDir, 'codex'));
    copyFileSync(join(fixtureBin, 'claude'), join(pathDir, 'claude'));
    const run = async (flag: string | undefined) => {
      const env = makeTestEnv({ path: pathDir });
      mkdirSync(join(env.home, '.claude'));
      const runner = recordingRunner();
      const out = capture();
      const err = capture();
      const vars: Record<string, string | undefined> = { HOME: env.home, PATH: pathDir };
      if (flag !== undefined) vars[VARIABLE] = flag;
      await main(['install', '--non-interactive', '--skip-inbound'], { env: { ...env, vars }, runner, out: out.write, err: err.write });
      return { runner, out };
    };
    const off = await run(OFF);
    expect(off.runner.calls.some((c) => basename(c.command) === 'codex')).toBe(false);
    expect(off.runner.calls.some((c) => basename(c.command) === 'claude' && c.args[0] === '--version')).toBe(true);
    expect(off.out.text()).not.toContain('Codex');

    const on = await run(ON);
    expect(on.runner.calls.some((c) => basename(c.command) === 'codex' && c.args[0] === '--version')).toBe(true);
    expect(on.out.text()).toContain('Found Codex CLI');
  });

  it('start when install.yml records codex', async () => {
    const off = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    expect(await main(['start'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expectNothingHappened(off);

    // A roles file in this folder would be listed and confirmed. With the flag off, nothing is shown or asked.
    const prompted = withFlag(installedOn('codex', 'file-mailbox', { ask: async () => 'y' }), OFF);
    const ask = vi.fn(async () => 'y');
    const deps: CliDeps = { ...prompted.deps, ask, env: { ...prompted.env, stdinIsTTY: true } };
    writeFileSync(join(prompted.env.cwd, 'sagespec.yml'), SMALL_TEAM);
    expect(await main(['start'], deps)).toBe(2);
    expect(ask).not.toHaveBeenCalled();
    expect(prompted.out.text()).toBe('');
    expect(prompted.err.text()).toBe(MESSAGE);

    const on = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['start'], on.deps)).toBe(0);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(on.runner.calls.filter((c) => c.kind === 'detached')).toHaveLength(1);
  });

  it('respawn when the team record and install.yml name codex', async () => {
    const record = { version: 1 as const, harness: 'codex' as const, transport: 'file-mailbox' as const, sessions: [{ name: 'main', pid: null, session_id: null }] };

    const off = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    writeTeam(off.env, record);
    expect(await main(['respawn', 'main'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    expect(off.err.text()).not.toContain('cannot stop');
    expect(off.runner.calls).toEqual([]);
    expect(off.out.text()).toBe('');
    expect(readTeam(off.env)).toMatchObject({ ok: true, record: { sessions: [{ name: 'main', pid: null }] } });

    // With the flag on, respawn goes past the gate to its own next check, which is unchanged.
    const on = withFlag(installedOn('codex', 'file-mailbox'), ON);
    writeTeam(on.env, record);
    expect(await main(['respawn', 'main'], on.deps)).toBe(1);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(on.err.text()).toContain('cannot stop main');
  });

  it('update when install.yml records codex', async () => {
    const fetchLatest = vi.fn(async () => ({ status: 'not-published' as const }));
    const off = withFlag(installedOn('codex', 'file-mailbox', { fetchLatest }), OFF);
    const before = readFileSync(installYmlPath(off.env), 'utf8');
    expect(await main(['update'], off.deps)).toBe(2);
    expect(off.err.text()).toContain(MESSAGE);
    // No network call, and no version line, before the refusal.
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(off.out.text()).toBe('');
    expect(off.runner.calls).toEqual([]);
    expect(readFileSync(installYmlPath(off.env), 'utf8')).toBe(before);

    const on = withFlag(installedOn('codex', 'file-mailbox', { fetchLatest }), ON);
    await main(['update', '--check'], on.deps);
    expect(on.err.text()).not.toContain(MESSAGE);
    expect(on.out.text()).toContain('--check: nothing was changed.');
  });

  it('stop and status still work with the flag off, so a running team can always be ended', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), OFF);
    writeTeam(t.env, {
      version: 1,
      harness: 'codex',
      transport: 'file-mailbox',
      supervisor_pid: 4100,
      supervisor_started: 'start-supervisor',
      sessions: [
        { name: 'main', pid: 4101, session_id: null, started: 'start-main' },
        { name: 'worker-1', pid: 4102, session_id: null, started: 'start-worker' },
      ],
    });
    for (const [pid, started] of [[4100, 'start-supervisor'], [4101, 'start-main'], [4102, 'start-worker']] as const) {
      t.runner.living.add(pid);
      t.runner.starts.set(pid, started);
    }
    t.deps.env = t.env;
    expect(await main(['status'], t.deps)).toBe(0);
    expect(t.out.text()).toContain('Team on Codex CLI');
    expect(t.out.text()).toMatch(/supervisor\s+pid 4100\s+running/);
    expect(t.out.text()).toMatch(/main\s+pid 4101\s+session -\s+running/);
    expect(t.out.text()).toMatch(/worker-1\s+pid 4102\s+session -\s+running/);

    expect(await main(['stop'], t.deps)).toBe(0);
    // Stop signals only the recorded processes, through the recording runner, and removes the record.
    expect(t.runner.calls.filter((c) => c.kind === 'kill').map((c) => Number(c.command))).toEqual([4100, 4101, 4102]);
    expect(t.runner.calls.filter((c) => c.kind !== 'kill')).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
    expect(t.err.text()).not.toContain(MESSAGE);
    expect(t.out.text()).not.toContain(MESSAGE);
  });
});

describe('the Codex supervisor checks the flag itself', () => {
  /** A job whose binary would leave a marker file if the supervisor ever started it. */
  function markerJob(cwd: string, home: string) {
    const dir = makeFixtureHome();
    const marker = join(dir, 'started');
    const bin = join(dir, 'codex');
    writeFileSync(bin, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(bin, 0o755);
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
    const job: SupervisorJob = { binary: bin, cwd, home, teamPath, sessions: [{ name: 'main', args: codexExecArgs([], 'k', dir) }] };
    return { job, marker, teamPath, dir };
  }

  it('with the flag off, refuses, logs the reason, and starts no child', async () => {
    for (const value of [undefined, '', '0', 'true']) {
      const { job, marker, teamPath } = markerJob(makeFixtureRepo().root, makeFixtureHome());
      const warnings: string[] = [];
      const vars: Record<string, string | undefined> = { [VARIABLE]: value };
      const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line), vars });
      await handle.done;
      expect(handle.refused).toBe(true);
      expect(warnings).toEqual([`trellis-crew supervisor: refused to start any session: ${MESSAGE}`]);
      expect(existsSync(marker)).toBe(false);
      const team = readTeamFile(teamPath);
      expect(team.ok && team.record?.sessions[0]?.pid).toBeNull();
    }
  });

  it('with the flag off and no warn option, writes the reason to codex-supervisor.log beside the team record', async () => {
    const { job, dir } = markerJob(makeFixtureRepo().root, makeFixtureHome());
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, vars: {} });
    await handle.done;
    expect(readFileSync(join(dir, 'codex-supervisor.log'), 'utf8')).toContain(`refused to start any session: ${MESSAGE}`);
  });

  it('with the flag on, goes on to its existing checks unchanged', async () => {
    // The working folder is the home folder, so the existing check refuses it, not the flag check.
    const home = makeFixtureHome();
    const { job, marker } = markerJob(home, home);
    const warnings: string[] = [];
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line), vars: { [VARIABLE]: '1' } });
    await handle.done;
    expect(handle.refused).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('it is your home folder');
    expect(warnings[0]).not.toContain(MESSAGE);
    expect(existsSync(marker)).toBe(false);
  });

  it('run as its own process on a job file with the flag off, exits 2 and starts nothing', () => {
    const { job, marker, dir } = markerJob(makeFixtureRepo().root, makeFixtureHome());
    const jobPath = join(dir, 'job.json');
    writeFileSync(jobPath, JSON.stringify(job));
    const ran = spawnSync(process.execPath, [supervisorScriptPath(), jobPath], {
      env: { PATH: process.env.PATH ?? '', HOME: dir },
      encoding: 'utf8',
    });
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain(MESSAGE);
    expect(existsSync(marker)).toBe(false);
  });

  it('run as its own process with the flag off, reads no job file and writes no log', () => {
    const dir = makeFixtureHome();
    const unreadable = join(dir, 'unreadable.json');
    writeFileSync(unreadable, JSON.stringify({ teamPath: join(dir, 'sub', 'team.json') }));
    chmodSync(unreadable, 0o000);
    // A readable job whose team folder exists: a supervisor that read it could log there.
    const readable = join(dir, 'readable.json');
    writeFileSync(readable, JSON.stringify({ teamPath: join(dir, 'team.json') }));
    for (const jobPath of [join(dir, 'does-not-exist.json'), unreadable, readable]) {
      const ran = spawnSync(process.execPath, [supervisorScriptPath(), jobPath], {
        env: { PATH: process.env.PATH ?? '', HOME: dir },
        encoding: 'utf8',
      });
      expect(ran.status).toBe(2);
      expect(ran.stderr).toBe(`trellis-crew supervisor: refused to start any session: ${MESSAGE}\n`);
    }
    // No log file anywhere in the fixture, including beside the named team path.
    expect(readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith('codex-supervisor.log'))).toEqual([]);
    chmodSync(unreadable, 0o600);
  });

  it('start passes the variable to the supervisor process in the env it spawns with', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['start'], t.deps)).toBe(0);
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    expect(spawn?.env?.[VARIABLE]).toBe('1');
  });

  it('up passes the variable to the supervisor process too', async () => {
    const t = withFlag(installedOn('codex', 'file-mailbox'), ON);
    expect(await main(['up', '--harness', 'codex', '--yes'], t.deps)).toBe(0);
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    expect(spawn?.env?.[VARIABLE]).toBe('1');
  });
});

describe('backstop: with the flag off, no Codex adapter method is ever called', () => {
  it('up, install, start, respawn, and update reach none of launch, launchAll, installPlugin, updatePlugin', async () => {
    const called: string[] = [];
    const trap = (name: string) => async () => {
      called.push(name);
      throw new Error(`codex adapter ${name} was called`);
    };
    const adapters = {
      codex: { ...codexAdapter, launch: trap('launch'), launchAll: trap('launchAll'), installPlugin: trap('installPlugin'), updatePlugin: trap('updatePlugin') },
    } as unknown as Partial<Record<HarnessId, Adapter>>;
    const fetchLatest = async () => ({ status: 'not-published' as const });
    const rig = () => withFlag(installedOn('codex', 'file-mailbox', { adapters, fetchLatest }), OFF);
    const team = { version: 1 as const, harness: 'codex' as const, transport: 'file-mailbox' as const, sessions: [{ name: 'main', pid: 41000, session_id: null }] };

    const runs: string[][] = [
      ['up', '--harness', 'codex', '--yes'],
      ['install', '--harness', 'codex', '--non-interactive'],
      ['install'],
      ['start'],
      ['respawn', 'main'],
      ['update'],
      ['update', '--check'],
    ];
    for (const argv of runs) {
      const t = rig();
      if (argv[0] === 'respawn') writeTeam(t.env, team);
      expect(await main(argv, t.deps)).toBe(2);
      expect(t.err.text()).toContain(MESSAGE);
    }
    expect(called).toEqual([]);
  });
});

/** The Claude Code configuration folder, which install needs to exist. */
function withClaudeFolder(t: Harnessed): Harnessed {
  mkdirSync(join(t.env.home, '.claude'));
  return t;
}

describe('Claude Code never reads the flag', () => {
  /** An Env whose vars record every name read from them. */
  function watched(t: Harnessed, reads: string[]): Harnessed {
    const vars = new Proxy({ HOME: t.env.home, PATH: t.env.path } as Record<string, string | undefined>, {
      get(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.has(target, key);
      },
    });
    const env = { ...t.env, vars };
    return { ...t, env, deps: { ...t.deps, env } };
  }

  it('up, install, start, respawn-free update, and status on claude-code with the flag absent', async () => {
    const reads: string[] = [];
    const up = watched(withClaudeFolder(installedOn('claude-code', 'native')), reads);
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], up.deps)).toBe(0);
    expect(up.err.text()).not.toContain(MESSAGE);

    const install = watched(withClaudeFolder(installedOn('claude-code', 'native')), reads);
    expect(await main(['install', '--harness', 'claude-code', '--non-interactive', '--skip-inbound'], install.deps)).toBe(0);

    const start = watched(installedOn('claude-code', 'native'), reads);
    expect(await main(['start'], start.deps)).toBe(0);

    const update = watched(installedOn('claude-code', 'native', { fetchLatest: async () => ({ status: 'not-published' as const }) }), reads);
    expect(await main(['update', '--check'], update.deps)).toBe(0);

    const respawn = watched(installedOn('claude-code', 'native'), reads);
    writeTeam(respawn.env, { version: 1, harness: 'claude-code', transport: 'native', sessions: [{ name: 'main', pid: null, session_id: null }] });
    expect(await main(['respawn', 'main'], respawn.deps)).toBe(1);
    expect(respawn.err.text()).toContain('cannot stop main');
    expect(respawn.err.text()).not.toContain(MESSAGE);

    expect(reads).not.toContain(VARIABLE);
  });

  it('a claude-code record is unaffected when the variable is set to something else', async () => {
    const t = withFlag(installedOn('claude-code', 'native'), '0');
    expect(await main(['start'], t.deps)).toBe(0);
    expect(t.err.text()).not.toContain(MESSAGE);
  });
});
