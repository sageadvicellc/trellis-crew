import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { parseCommand, USAGE } from '../src/args.ts';
import { main, type CliDeps } from '../src/cli.ts';
import { upInstallOptions } from '../src/commands/up.ts';
import { readInstallRecord, writeInstallRecord } from '../src/store/install-yml.ts';
import { readTeam, teamJsonPath } from '../src/store/team-json.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { capture, type Capture } from './helpers/io.ts';
import { fixtureBin, repoRoot } from './helpers/paths.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { isGitCall } from './helpers/recording-runner.ts';
import { gitRunner, type GitRunner } from './helpers/git-runner.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { writeRoles } from './helpers/team.ts';
import type { Env } from '../src/env.ts';

interface Rig {
  env: Env;
  runner: GitRunner;
  out: Capture;
  err: Capture;
  ask: ReturnType<typeof vi.fn>;
  deps: CliDeps;
  settings: string;
}

/**
 * A fresh fixture home with no install.yml, a Claude Code folder, and a
 * git runner that runs real git and nothing else. The current folder
 * is the top of a temp git repository, where Codex sessions may start.
 */
function rig(options: { tty?: boolean } = {}): Rig {
  const env = makeTestEnv({ stdinIsTTY: options.tty === true, cwd: makeFixtureRepo().root });
  mkdirSync(join(env.home, '.claude'));
  const settings = join(env.home, '.claude', 'settings.json');
  writeFileSync(settings, '{"theme": "dark"}\n');
  const runner = gitRunner();
  const out = capture();
  const err = capture();
  const ask = vi.fn(async () => 'y');
  return {
    env,
    runner,
    out,
    err,
    ask,
    settings,
    deps: { env, runner, out: out.write, err: err.write, ask, now: () => new Date('2026-03-04T10:00:00Z') },
  };
}

function supervisorJob(t: Rig): SupervisorJob {
  const spawns = t.runner.calls.filter((c) => c.kind === 'detached');
  expect(spawns).toHaveLength(1);
  return JSON.parse(readFileSync(spawns[0]?.args[1] as string, 'utf8')) as SupervisorJob;
}

const settingsOf = (t: Rig): unknown => JSON.parse(readFileSync(t.settings, 'utf8'));
const bgRuns = (t: Rig) => t.runner.calls.filter((c) => c.kind === 'run' && c.args[0] === '--bg');

describe('up: parsing', () => {
  it('parses --harness with the flags that start takes', () => {
    expect(parseCommand(['up', '--harness', 'codex'])).toEqual({
      ok: true,
      command: { name: 'up', harness: 'codex', yes: false, acceptInbound: false, skipInbound: false },
    });
    expect(parseCommand(['up', '--harness', 'claude-code', '--workers', '2', '--roles', 'team.yml', '-y', '--skip-inbound'])).toEqual({
      ok: true,
      command: { name: 'up', harness: 'claude-code', workers: 2, roles: 'team.yml', yes: true, acceptInbound: false, skipInbound: true },
    });
    expect(parseCommand(['up', '--harness', 'claude-code', '--accept-inbound'])).toMatchObject({
      ok: true,
      command: { acceptInbound: true, skipInbound: false },
    });
  });

  it('needs --harness, and takes only codex or claude-code', () => {
    expect(parseCommand(['up'])).toMatchObject({ ok: false, message: expect.stringMatching(/up needs --harness codex or --harness claude-code/) });
    for (const name of ['hermes', 'qwen-code', 'amp', 'opencode', 'bogus', 'Codex CLI', 'claude']) {
      expect(parseCommand(['up', '--harness', name])).toMatchObject({
        ok: false,
        message: expect.stringContaining(`not "${name}"`),
      });
    }
  });

  it('refuses a --roles value that is a URL or a git@ address', () => {
    for (const value of ['https://example.com/team.yml', 'file:///tmp/team.yml', 'ssh://host/team.yml', 'git@example.com:team.git']) {
      expect(parseCommand(['up', '--harness', 'codex', '--roles', value])).toMatchObject({
        ok: false,
        message: expect.stringMatching(/--roles takes a local file path, not a URL or a git address/),
      });
    }
  });

  it('refuses --accept-inbound with --skip-inbound, a bad worker count, and an unknown flag', () => {
    expect(parseCommand(['up', '--harness', 'claude-code', '--accept-inbound', '--skip-inbound'])).toMatchObject({
      ok: false,
      message: '--accept-inbound and --skip-inbound cannot be used together',
    });
    expect(parseCommand(['up', '--harness', 'codex', '--workers', '0'])).toMatchObject({ ok: false });
    expect(parseCommand(['up', '--harness', 'codex', '--reconfigure'])).toMatchObject({ ok: false });
  });

  it('a usage error exits 2, installs nothing, and starts nothing', async () => {
    for (const argv of [['up'], ['up', '--harness', 'hermes'], ['up', '--harness', 'codex', '--roles', 'https://example.com/t.yml']]) {
      const t = rig();
      expect(await main(argv, t.deps)).toBe(2);
      expect(t.runner.calls).toEqual([]);
      expect(existsSync(join(t.env.home, '.trellis-crew'))).toBe(false);
    }
  });

  // No other test guards the up line in USAGE: cli.test checks only that help prints the start line.
  it('USAGE names up and its flags', () => {
    expect(USAGE).toContain(
      'trellis-crew up --harness <codex|claude-code> [--workers N] [--roles sagespec.yml] [--yes] [--accept-inbound | --skip-inbound]',
    );
  });
});

/** The hints that up gives the install step, spelled out once. */
function upHints(harness: string) {
  return {
    inboundMissing: 'Run up again with --accept-inbound to set it, or with --skip-inbound to leave it.',
    rolesNoTerminal: 'trellis-crew up asks no question about a roles file. Read it, then run up again with --yes.',
    recordDamaged: `Run trellis-crew install --reconfigure --harness ${harness} first, then run up again.`,
  };
}

describe('up: the install step', () => {
  it('builds the install options as if install --harness <name> --non-interactive were given', () => {
    expect(parseCommand(['install', '--harness', 'codex', '--non-interactive'])).toEqual({
      ok: true,
      command: { name: 'install', harness: 'codex', nonInteractive: true, reconfigure: false, yes: false, skipInbound: false },
    });
    expect(upInstallOptions({ harness: 'codex', yes: false, acceptInbound: false, skipInbound: false })).toEqual({
      harness: 'codex',
      nonInteractive: true,
      reconfigure: false,
      yes: false,
      skipInbound: false,
      rolesYes: false,
      keepStoredTransport: true,
      hints: upHints('codex'),
    });
    expect(upInstallOptions({ harness: 'claude-code', yes: false, acceptInbound: false, skipInbound: false })).toEqual({
      harness: 'claude-code',
      nonInteractive: true,
      reconfigure: false,
      yes: false,
      skipInbound: false,
      rolesYes: false,
      keepStoredTransport: true,
      hints: upHints('claude-code'),
    });
  });

  it('up --yes never consents to the inbound setting; only --accept-inbound does', () => {
    const base = { harness: 'claude-code' as const, acceptInbound: false, skipInbound: false };
    const common = { harness: 'claude-code', nonInteractive: true, reconfigure: false, keepStoredTransport: true, hints: upHints('claude-code') };
    expect(upInstallOptions({ ...base, yes: true })).toEqual({ ...common, yes: false, skipInbound: false, rolesYes: true });
    expect(upInstallOptions({ ...base, yes: false, acceptInbound: true })).toEqual({ ...common, yes: true, skipInbound: false, rolesYes: false });
    expect(upInstallOptions({ ...base, yes: false, skipInbound: true })).toEqual({ ...common, yes: false, skipInbound: true, rolesYes: false });
    expect(upInstallOptions({ ...base, yes: false, roles: 'team.yml' })).toEqual({
      ...common,
      yes: false,
      skipInbound: false,
      rolesYes: false,
      roles: 'team.yml',
    });
  });

  it('under up, keeps the transport that install.yml records for the same harness, and says so', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'claude-code', transport: 'file-mailbox', plugin_version: null });
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], t.deps)).toBe(0);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'claude-code', transport: 'file-mailbox' } });
    expect(t.out.text()).toContain('Keeping the file-mailbox transport, stored in install.yml.');
    expect(readTeam(t.env)).toMatchObject({ ok: true, record: { transport: 'file-mailbox' } });
  });

  it('under up, a stored transport for another harness is not kept', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'codex', transport: 'a2a', plugin_version: null });
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], t.deps)).toBe(0);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'claude-code', transport: 'native' } });
    expect(t.out.text()).not.toContain('Keeping the');
  });

  it('plain install --harness still resets the transport, as before', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'claude-code', transport: 'file-mailbox', plugin_version: null });
    expect(await main(['install', '--harness', 'claude-code', '--non-interactive', '--skip-inbound'], t.deps)).toBe(0);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'claude-code', transport: 'native' } });
    expect(t.out.text()).not.toContain('Keeping the');
  });

  it('a damaged install.yml under up names a command to run first, and plain install keeps its own hint', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'codex', transport: 'file-mailbox', plugin_version: null });
    writeFileSync(join(t.env.home, '.trellis-crew', 'install.yml'), 'harness: [\n');
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toContain('Run trellis-crew install --reconfigure --harness codex first, then run up again.');
    expect(t.err.text()).not.toContain('to write it again');
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 1. Nothing was started.');

    const plain = rig();
    writeInstallRecord(plain.env, { harness: 'codex', transport: 'file-mailbox', plugin_version: null });
    writeFileSync(join(plain.env.home, '.trellis-crew', 'install.yml'), 'harness: [\n');
    expect(await main(['install', '--harness', 'codex'], plain.deps)).toBe(1);
    expect(plain.err.text()).toContain('Run trellis-crew install --reconfigure to write it again.');
  });
});

describe('up --harness codex', () => {
  it('installs with no question, then starts the team under the supervisor, in one step', async () => {
    const t = rig({ tty: true });
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    expect(t.ask).not.toHaveBeenCalled();
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'codex', transport: 'file-mailbox' } });
    // The skills go into the project, never under home.
    expect(readdirSync(join(t.env.cwd, '.agents', 'skills')).sort()).toEqual(readdirSync(join(repoRoot, 'skills')).sort());
    expect(existsSync(join(t.env.home, '.agents'))).toBe(false);
    // No probe runs, because --harness names the harness, and no codex process runs in a test.
    // Apart from git, no command runs.
    expect(t.runner.calls.filter((c) => c.kind === 'run')).toEqual([]);
    // The working-folder check runs once before step 1, and once before the supervisor starts.
    // The skill export in step 1 makes its own worktree-top check, one more `rev-parse --show-toplevel`.
    const toplevel = ['rev-parse', '--show-toplevel'];
    const settings = ['config', '--list', '--show-origin', '--includes', '-z'];
    const gitArgs = t.runner.gitCalls.map((c) => c.args);
    expect(gitArgs.filter((args) => args.join('\0') === toplevel.join('\0'))).toHaveLength(3);
    expect(gitArgs.filter((args) => args.join('\0') === settings.join('\0'))).toHaveLength(2);
    // The order: the working-folder check comes first, its top and then its settings,
    // before the export's own worktree-top check.
    expect(gitArgs.slice(0, 3)).toEqual([toplevel, settings, toplevel]);
    const job = supervisorJob(t);
    expect(job.binary).toBe(join(fixtureBin, 'codex'));
    expect(job.sessions).toHaveLength(6);
    const team = readTeam(t.env);
    expect(team.ok && team.record?.harness).toBe('codex');
    const text = t.out.text();
    expect(text.indexOf('Step 1 of 2: install on Codex CLI')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Step 1 of 2')).toBeLessThan(text.indexOf('Step 2 of 2: start the team.'));
    expect(text.indexOf('Step 2 of 2')).toBeLessThan(text.indexOf('Started the supervisor'));
  });

  it('every codex exec session runs in workspace-write with network access off and the mailbox writable, and no bypass flag appears', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    const mailbox = join(t.env.home, '.trellis-crew', 'mailbox');
    for (const session of supervisorJob(t).sessions) {
      expect(session.args.slice(0, -1)).toEqual([
        'exec',
        '--sandbox',
        'workspace-write',
        '-c',
        'sandbox_workspace_write.network_access=false',
        '-c',
        `sandbox_workspace_write.writable_roots=[${JSON.stringify(mailbox)}]`,
        '--',
      ]);
      expect(session.args.at(-1)).toMatch(/You are|trellis-crew start-up/);
      for (const arg of session.args.slice(0, -1)) {
        expect(arg).not.toContain('danger-full-access');
        expect(arg).not.toContain('dangerously-bypass-approvals-and-sandbox');
      }
    }
  });

  it('passes --workers through to start', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex', '--workers', '2'], t.deps)).toBe(0);
    expect(supervisorJob(t).sessions.map((s) => s.name)).toEqual(['personal-assistant', 'main', 'benchmark', 'worker-1', 'worker-2']);
  });

  it('passes --roles through to start, and asks nothing for a file named on the command line', async () => {
    const t = rig({ tty: true });
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM);
    expect(await main(['up', '--harness', 'codex', '--roles', 'team.yml'], t.deps)).toBe(0);
    expect(t.ask).not.toHaveBeenCalled();
    expect(supervisorJob(t).sessions.map((s) => s.name)).toEqual(['chain', 'boss', 'helper-a', 'helper-b', 'watcher']);
    const team = readTeam(t.env);
    expect(team.ok && team.record?.roles?.file).toBe(file);
  });

  it('stops at a failed install with its message, names the step, and starts nothing', async () => {
    const t = rig();
    // A PATH with git, for the working-folder check, and no codex.
    const gitOnly = join(t.env.home, 'git-only');
    mkdirSync(gitOnly);
    copyFileSync(join(fixtureBin, 'git'), join(gitOnly, 'git'));
    const bare = { ...t.deps, env: { ...t.env, path: gitOnly } };
    expect(await main(['up', '--harness', 'codex'], bare)).toBe(1);
    expect(t.err.text()).toContain('Codex CLI is not on PATH, so the plugin cannot be installed.');
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 1. Nothing was started.');
    expect(t.out.text()).not.toContain('Step 2 of 2');
    expect(t.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('names the start step when start fails after the install', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(0);
    const before = t.runner.calls.filter((c) => !isGitCall(c)).length;
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/A team record already exists/);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 2 of 2, start, with exit code 1.');
    expect(t.runner.calls.filter((c) => !isGitCall(c)).length).toBe(before);
  });

  it('a roles file found in this folder needs --yes, because up asks no question', async () => {
    const t = rig({ tty: true });
    writeFileSync(join(t.env.cwd, 'sagespec.yml'), SMALL_TEAM);
    expect(await main(['up', '--harness', 'codex'], t.deps)).toBe(2);
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.err.text()).toContain('trellis-crew up asks no question about a roles file. Read it, then run up again with --yes.');
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 2. Nothing was started.');
    expect(t.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);

    const yes = rig({ tty: true });
    writeFileSync(join(yes.env.cwd, 'sagespec.yml'), SMALL_TEAM);
    expect(await main(['up', '--harness', 'codex', '--yes'], yes.deps)).toBe(0);
    expect(yes.ask).not.toHaveBeenCalled();
    expect(supervisorJob(yes).sessions.map((s) => s.name)).toEqual(['chain', 'boss', 'helper-a', 'helper-b', 'watcher']);
  });

  it('refuses a roles file that names another harness before the install, so nothing is installed', async () => {
    const t = rig();
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('harness: auto', 'harness: claude-code'));
    expect(await main(['up', '--harness', 'codex', '--roles', file], t.deps)).toBe(2);
    expect(t.err.text()).toContain(`${file}: the roles file names the harness claude-code, but --harness is codex. Nothing was started.`);
    expect(t.err.text()).toContain(STOPPED_BEFORE_INSTALL);
    expectNothingInstalled(t);
  });

  it('refuses a found ./sagespec.yml that names another harness, or that is not valid, before the install', async () => {
    const other = rig();
    writeFileSync(join(other.env.cwd, 'sagespec.yml'), SMALL_TEAM.replace('harness: auto', 'harness: claude-code'));
    expect(await main(['up', '--harness', 'codex', '--yes'], other.deps)).toBe(2);
    expect(other.err.text()).toMatch(/sagespec\.yml: the roles file names the harness claude-code, but --harness is codex/);
    expectNothingInstalled(other);

    const broken = rig();
    writeFileSync(join(broken.env.cwd, 'sagespec.yml'), SMALL_TEAM.replace('version: 1', 'version: 9'));
    expect(await main(['up', '--harness', 'codex', '--yes'], broken.deps)).toBe(2);
    expect(broken.err.text()).toMatch(/sagespec\.yml:\d+: /);
    expect(broken.err.text()).toContain(STOPPED_BEFORE_INSTALL);
    expectNothingInstalled(broken);
  });

  it('refuses the home folder, /, a folder that is not a repo, and a repo subfolder before the install', async () => {
    const cases: [string, (t: Rig) => string, RegExp][] = [
      ['home', (t) => t.env.home, /: it is your home folder\./],
      ['root', () => '/', /\/: it is the root folder\./],
      ['plain', () => makeFixtureHome(), /: it is not in a git worktree \(/],
      [
        'sub',
        (t) => {
          mkdirSync(join(t.env.cwd, 'sub'));
          return join(t.env.cwd, 'sub');
        },
        /: it is not the top of a git worktree\. The top is /,
      ],
    ];
    for (const [, folder, reason] of cases) {
      const t = rig();
      const deps = { ...t.deps, env: { ...t.env, cwd: folder(t) } };
      expect(await main(['up', '--harness', 'codex', '--yes'], deps)).toBe(2);
      expect(t.err.text()).toContain('Codex CLI sessions can write their working folder, so trellis-crew starts them only at the top of a git worktree.');
      expect(t.err.text()).toMatch(reason);
      expect(t.err.text()).toContain(STOPPED_BEFORE_INSTALL);
      expectNothingInstalled(t);
    }
  });

  it('refuses a roles file whose mailbox is outside the state folder, before the install', async () => {
    const t = rig();
    writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/team-mail'));
    expect(await main(['up', '--harness', 'codex', '--roles', 'team.yml'], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/The file mailbox on Codex CLI must be a folder inside .*\.trellis-crew, because every session can write it\. .*team-mail: it is outside the state folder\./);
    expect(t.err.text()).toContain(STOPPED_BEFORE_INSTALL);
    expectNothingInstalled(t);
    expect(existsSync(join(t.env.home, 'team-mail'))).toBe(false);
  });

  it('on Claude Code, up keeps its working-folder and mailbox behavior, because Claude Code sessions get no Codex sandbox', async () => {
    const t = rig();
    const deps = { ...t.deps, env: { ...t.env, cwd: t.env.home } };
    writeRoles(deps.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/team-mail').replace('transport: auto', 'transport: file-mailbox'));
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound', '--roles', 'team.yml'], deps)).toBe(0);
    expect(t.runner.gitCalls).toEqual([]);
    expect(existsSync(join(t.env.home, 'team-mail'))).toBe(true);
  });

  it('applies the harness bounds before the install, so a --roles file out of bounds installs nothing', async () => {
    const t = rig();
    writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 99k'));
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound', '--roles', 'team.yml'], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/team\.yml:\d+: .*100k to 1M/);
    expectNothingInstalled(t);
  });
});

const STOPPED_BEFORE_INSTALL = 'trellis-crew up stopped at step 1 of 2, install, with exit code 2. Nothing was installed or started.';
const STOPPED_AFTER_INSTALL = 'trellis-crew up stopped at step 2 of 2, start, with exit code 2. Nothing was started. The install step already ran.';

/** No install side effect: no install.yml, no skills, no plugin command, no team record. Only the git check may run. */
function expectNothingInstalled(t: Rig): void {
  expect(t.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
  expect(existsSync(join(t.env.home, '.trellis-crew', 'install.yml'))).toBe(false);
  expect(existsSync(join(t.env.home, '.agents'))).toBe(false);
  expect(existsSync(join(t.env.cwd, '.agents'))).toBe(false);
  expect(existsSync(teamJsonPath(t.env))).toBe(false);
  expect(t.out.text()).not.toContain('Step 1 of 2');
}

/** A Claude Code rig whose plugin install step runs `during` once, to change the roles file between the two steps. */
function changedDuringInstall(during: (t: Rig) => void): Rig {
  const t = rig();
  let done = false;
  const runner = gitRunner((_command, args) => {
    if (!done && args[0] === 'plugin' && args[1] === 'install') {
      done = true;
      during(t);
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  });
  return { ...t, runner, deps: { ...t.deps, runner } };
}

describe('up reads the --roles file once', () => {
  it('refuses to start when the file changed during the install', async () => {
    const t = changedDuringInstall((r) => writeRoles(r.env, 'team.yml', SMALL_TEAM.replace('You help too.', 'You help, changed.')));
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM);
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound', '--roles', 'team.yml'], t.deps)).toBe(2);
    expect(t.err.text()).toContain(`${file}: the roles file changed after up read it. Nothing was started.`);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 2 of 2, start, with exit code 2. The install step already ran.');
    expect(bgRuns(t)).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('the second check refuses a file that became a symbolic link during the install', async () => {
    const t = changedDuringInstall((r) => {
      const real = writeRoles(r.env, 'real.yml', SMALL_TEAM);
      rmSync(join(r.env.cwd, 'team.yml'));
      symlinkSync(real, join(r.env.cwd, 'team.yml'));
    });
    writeRoles(t.env, 'team.yml', SMALL_TEAM);
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound', '--roles', 'team.yml'], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/--roles must name a local regular file \(the last part of the path is a symbolic link\)\.$/m);
    expect(t.err.text()).toContain(STOPPED_AFTER_INSTALL);
    expect(bgRuns(t)).toEqual([]);
  });

  it('start --roles still follows a symbolic link, as before', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'claude-code', transport: 'native', plugin_version: null });
    const real = writeRoles(t.env, 'real.yml', SMALL_TEAM);
    symlinkSync(real, join(t.env.cwd, 'team.yml'));
    expect(await main(['start', '--roles', 'team.yml'], t.deps)).toBe(0);
    expect(bgRuns(t)).toHaveLength(5);
  });
});

describe('up --roles is a local regular file', () => {
  it('refuses a missing file, a folder, and a symbolic link, before any install', async () => {
    const missing = rig();
    expect(await main(['up', '--harness', 'codex', '--roles', 'nope.yml'], missing.deps)).toBe(2);
    const path = join(missing.env.cwd, 'nope.yml');
    // The reason carries the error message, not only its code.
    expect(missing.err.text()).toContain(`${path}: --roles must name a local regular file (ENOENT: no such file or directory, open '${path}').`);

    const folder = rig();
    mkdirSync(join(folder.env.cwd, 'team'));
    expect(await main(['up', '--harness', 'codex', '--roles', 'team'], folder.deps)).toBe(2);
    expect(folder.err.text()).toMatch(/--roles must name a local regular file \(not a regular file\)\.$/m);

    const link = rig();
    const real = writeRoles(link.env, 'real.yml', SMALL_TEAM);
    symlinkSync(real, join(link.env.cwd, 'team.yml'));
    expect(await main(['up', '--harness', 'codex', '--roles', 'team.yml'], link.deps)).toBe(2);
    expect(link.err.text()).toMatch(/--roles must name a local regular file \(the last part of the path is a symbolic link\)\.$/m);

    for (const t of [missing, folder, link]) {
      expect(t.err.text()).toContain(STOPPED_BEFORE_INSTALL);
      expectNothingInstalled(t);
      expect(existsSync(join(t.env.home, '.trellis-crew'))).toBe(false);
    }
  });
});

describe('up --harness claude-code', () => {
  it('with --accept-inbound, installs the plugin, sets the inbound setting, then starts each session', async () => {
    const t = rig({ tty: true });
    expect(await main(['up', '--harness', 'claude-code', '--accept-inbound'], t.deps)).toBe(0);
    expect(t.ask).not.toHaveBeenCalled();
    const runs = t.runner.calls.filter((c) => c.kind === 'run');
    expect(runs.slice(0, 2).map((c) => c.args.slice(0, 2))).toEqual([
      ['plugin', 'marketplace'],
      ['plugin', 'install'],
    ]);
    expect(runs.some((c) => c.args.includes('--version'))).toBe(false);
    expect(bgRuns(t)).toHaveLength(6);
    expect(settingsOf(t)).toEqual({ theme: 'dark', crossSessionInbound: 'accept' });
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'claude-code', transport: 'native' } });
    expect(t.out.text()).toMatch(/every Claude Code session/);
  });

  it('with no inbound flag, it asks nothing, leaves the settings file alone, names up\'s flags, and starts nothing', async () => {
    const t = rig({ tty: true });
    expect(await main(['up', '--harness', 'claude-code'], t.deps)).toBe(1);
    expect(t.ask).not.toHaveBeenCalled();
    expect(settingsOf(t)).toEqual({ theme: 'dark' });
    expect(existsSync(`${t.settings}.2026-03-04.bak`)).toBe(false);
    expect(t.err.text()).toContain('Run up again with --accept-inbound to set it, or with --skip-inbound to leave it.');
    expect(t.err.text()).not.toMatch(/install again with --yes/);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 1. Nothing was started.');
    expect(bgRuns(t)).toEqual([]);
    expect(existsSync(teamJsonPath(t.env))).toBe(false);
  });

  it('--yes alone does not consent to the inbound setting', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'claude-code', '--yes'], t.deps)).toBe(1);
    expect(settingsOf(t)).toEqual({ theme: 'dark' });
    expect(bgRuns(t)).toEqual([]);
  });

  it('with --skip-inbound, leaves the settings file alone and starts the team', async () => {
    const t = rig();
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound', '--workers', '1'], t.deps)).toBe(0);
    expect(settingsOf(t)).toEqual({ theme: 'dark' });
    expect(bgRuns(t).map((c) => c.args[2])).toEqual(['personal-assistant', 'main', 'benchmark', 'worker-1']);
  });

  it('stops at a failed plugin install with its message', async () => {
    const t = rig();
    const failing = gitRunner((_command, args) =>
      args[0] === 'plugin' ? { code: 1, stdout: '', stderr: 'fixture refusal\n', timedOut: false } : { code: 0, stdout: '', stderr: '', timedOut: false },
    );
    expect(await main(['up', '--harness', 'claude-code', '--skip-inbound'], { ...t.deps, runner: failing })).toBe(1);
    expect(t.err.text()).toMatch(/The plugin install failed: claude plugin marketplace add .*: fixture refusal/);
    expect(t.err.text()).toContain('trellis-crew up stopped at step 1 of 2, install, with exit code 1. Nothing was started.');
    expect(failing.calls.filter((c) => c.args[0] === '--bg')).toEqual([]);
  });
});
