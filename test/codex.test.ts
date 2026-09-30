import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.ts';
import { codexExecArgs, codexSandboxArgs, execArgsProblem, refusedCodexFlag } from '../src/adapters/codex-args.ts';
import { runSupervisor, type SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import { main } from '../src/cli.ts';
import { processStartTime } from '../src/runner.ts';
import { readTeam, readTeamFile, writeTeamFile } from '../src/store/team-json.ts';
import { makeFixtureHome } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { isGitCall } from './helpers/recording-runner.ts';
import { fixtureBin, repoRoot } from './helpers/paths.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

/** The supervisor reads the experimental Codex flag from its options here, so these tests set it themselves. */
const FLAG_ON = { TRELLIS_EXPERIMENTAL_CODEX: '1' };

function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every `codex exec` argv up to the kickoff: the sandbox, network access off, the writable roots, then `--`. */
function sandboxedExec(roots: readonly string[]): string[] {
  return [
    'exec',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    '--',
  ];
}

function expectNoBypass(args: readonly string[]): void {
  for (const arg of args) {
    expect(arg).not.toContain('danger-full-access');
    expect(arg).not.toContain('dangerously-bypass-approvals-and-sandbox');
  }
}

describe('codex exec arguments', () => {
  it('sets workspace-write, network access off, and the mailbox as the one writable root, and puts the kickoff after --', () => {
    expect(codexExecArgs([], 'do the work', '/srv/mail')).toEqual([...sandboxedExec(['/srv/mail']), 'do the work']);
    // A kickoff that starts with - stays the prompt, because it follows --.
    expect(codexExecArgs([], '--dangerously-bypass-approvals-and-sandbox', '/srv/mail')).toEqual([
      ...sandboxedExec(['/srv/mail']),
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    // With no mailbox, the writable roots are empty, so none from the user's config apply.
    expect(codexExecArgs([], 'k', undefined)).toEqual([...sandboxedExec([]), 'k']);
    // The path is quoted as a TOML string, so a quote or a backslash in it stays inside the string.
    expect(codexSandboxArgs('/srv/a "b"\\c').at(-1)).toBe('sandbox_workspace_write.writable_roots=["/srv/a \\"b\\"\\\\c"]');
    const args = codexExecArgs([], 'k', '/srv/mail');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expectNoBypass(args.slice(0, -1));
  });

  it('refuses a mailbox path with a control character, or one that is not absolute', () => {
    expect(() => codexSandboxArgs('/srv/mail\nx')).toThrow(/the mailbox folder path holds a control character/);
    expect(() => codexSandboxArgs('/srv/mail\u007f')).toThrow(/control character/);
    expect(() => codexSandboxArgs('mail')).toThrow(/must be an absolute path/);
  });

  it('refuses every launch flag, because no Codex launch flag is verified', () => {
    const refused = [
      ['--sandbox', 'danger-full-access'],
      ['--sandbox=danger-full-access'],
      ['-s', 'danger-full-access'],
      ['-sdanger-full-access'],
      ['-c', 'sandbox_mode="danger-full-access"'],
      ['--config', 'sandbox_workspace_write.network_access=true'],
      ['--dangerously-bypass-approvals-and-sandbox'],
      ['--add-dir', '/'],
      ['-C', '/'],
      ['-p', 'wide-open'],
      ['--profile', 'wide-open'],
      ['--enable', 'x'],
      ['--ignore-user-config'],
      ['--oss'],
      ['-m', 'model-a'],
    ];
    for (const flagArgs of refused) {
      expect(refusedCodexFlag(flagArgs)).toBe(
        `the launch flag "${flagArgs[0]}" is refused on Codex CLI, because no Codex launch flag is verified. trellis-crew sets the sandbox itself.`,
      );
      expect(() => codexExecArgs(flagArgs, 'k', '/srv/mail')).toThrow(/is refused on Codex CLI/);
    }
    expect(refusedCodexFlag([])).toBeUndefined();
  });

  it('refuses a bare word, which codex exec reads as a subcommand or the prompt', () => {
    for (const word of ['resume', 'fork', 'review', 'help']) {
      expect(refusedCodexFlag([word])).toBe(`the launch argument "${word}" is refused on Codex CLI, because it is a codex exec subcommand.`);
    }
    expect(refusedCodexFlag(['danger-full-access'])).toBe('the launch argument "danger-full-access" is refused on Codex CLI, because it is not a flag.');
  });

  it('checks a value apart from its flag name, once a flag is verified', () => {
    const verified = new Set(['-m']);
    // A model name is a value. It never trips the name check.
    expect(refusedCodexFlag(['-m', 'sonnet'], verified)).toBeUndefined();
    expect(refusedCodexFlag(['-m', 'danger-full-access'], verified)).toBeUndefined();
    expect(refusedCodexFlag(['-m', 'review'], verified)).toBeUndefined();
    expect(refusedCodexFlag(['-m', '-sonnet'], verified)).toBe('the value "-sonnet" of the launch flag "-m" is refused on Codex CLI, because it starts with -.');
    expect(refusedCodexFlag(['-m'], verified)).toBe('the launch flag "-m" is refused on Codex CLI, because it has no value.');
    expect(refusedCodexFlag(['-m', 'a\nb'], verified)).toMatch(/because it holds a control character/);
    expect(refusedCodexFlag(['-m', 'sonnet', '--oss'], verified)).toMatch(/"--oss" is refused/);
  });

  it('execArgsProblem accepts only the exact sandbox arguments', () => {
    expect(execArgsProblem(codexExecArgs([], 'k', '/srv/mail'))).toBeUndefined();
    expect(execArgsProblem(codexExecArgs([], 'k', undefined))).toBeUndefined();
    expect(execArgsProblem(['exec', 'k'])).toMatch(/not the sandbox arguments that trellis-crew sets/);
    const wide = codexExecArgs([], 'k', '/srv/mail').map((a) => (a === 'workspace-write' ? 'danger-full-access' : a));
    expect(execArgsProblem(wide)).toMatch(/not the sandbox arguments that trellis-crew sets/);
    const netOn = codexExecArgs([], 'k', '/srv/mail').map((a) => a.replace('network_access=false', 'network_access=true'));
    expect(execArgsProblem(netOn)).toMatch(/not the sandbox arguments/);
    const twoRoots = codexExecArgs([], 'k', '/srv/mail').map((a) => a.replace('["/srv/mail"]', '["/srv/mail","/"]'));
    expect(execArgsProblem(twoRoots)).toMatch(/not the sandbox arguments/);
    expect(execArgsProblem(['exec', '--oss', ...codexExecArgs([], 'k', '/srv/mail').slice(1)])).toMatch(/"--oss" is refused/);
  });

  it('respawn refuses an injected sandbox flag and starts nothing', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {}, mailbox: '/srv/mail' };
    const outcome = await codexAdapter.launch('main', 'k', ['--sandbox', 'danger-full-access'], ctx);
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/"--sandbox" is refused on Codex CLI/) });
    expect(t.runner.calls).toEqual([]);
  });

  it('respawn passes the mailbox as the writable root', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const mailbox = join(t.env.home, '.trellis-crew', 'mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {}, mailbox };
    expect(await codexAdapter.launch('main', 'k', [], ctx)).toMatchObject({ ok: true });
    expect(t.runner.calls.find((c) => c.kind === 'detached')?.args).toEqual([...sandboxedExec([mailbox]), 'k']);
  });

  it('launchAll refuses a mailbox path with a control character, and starts nothing', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {}, mailbox: '/srv/ma\til' };
    const outcome = await codexAdapter.launchAll?.([{ name: 'main', kickoff: 'k', flagArgs: [] }], ctx, join(t.env.home, 'team.json'));
    expect(outcome).toEqual({ ok: false, message: expect.stringMatching(/^main: the mailbox folder path holds a control character/) });
    expect(t.runner.calls).toEqual([]);
  });

  it('start gives each session the default mailbox as its writable root', async () => {
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    const mailbox = join(t.env.home, '.trellis-crew', 'mailbox');
    for (const session of job.sessions) expect(session.args.slice(0, -1)).toEqual(sandboxedExec([mailbox]));
  });

  it('start gives each session a custom mailbox from the roles file as its writable root', async () => {
    const t = installedOn('codex', 'file-mailbox');
    // On Codex the mailbox must sit inside the state folder, so the custom one is there.
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/.trellis-crew/team-mail'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    const mailbox = join(t.env.home, '.trellis-crew', 'team-mail');
    for (const session of job.sessions) expect(session.args.slice(0, -1)).toEqual(sandboxedExec([mailbox]));
  });

  it('start refuses a roles-file flag that reaches the sandbox, and starts no supervisor', async () => {
    // Codex has no verified launch flag today, so a stand-in maps model to --sandbox to show the guard holds.
    const leaky = { ...codexAdapter, flags: { model: '--sandbox' } };
    const t = installedOn('codex', 'file-mailbox', { adapters: { codex: leaky } });
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: danger-full-access'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(1);
    expect(t.err.text()).toContain('helper-a: the launch flag "--sandbox" is refused on Codex CLI, because no Codex launch flag is verified.');
    expect(t.runner.calls).toEqual([]);
    expect(readTeam(t.env)).toEqual({ ok: true, record: undefined });
  });

  it('a roles-file value on Codex is ignored with a warning, so it never reaches codex exec', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: danger-full-access'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.text()).toContain('warning: helper-a: model ignored. Codex CLI has no verified flag for it.');
    const spawn = t.runner.calls.find((c) => c.kind === 'detached');
    const job = JSON.parse(readFileSync(spawn?.args[1] as string, 'utf8')) as SupervisorJob;
    for (const session of job.sessions) {
      expect(session.args.slice(0, -1)).toEqual(sandboxedExec([join(t.env.home, '.trellis-crew', 'mailbox')]));
      expectNoBypass(session.args.slice(0, -1));
    }
  });
});

describe('Codex CLI', () => {
  it('49: start returns at once while the detached supervisor keeps running', async () => {
    const t = installedOn('codex', 'file-mailbox');
    expect(await main(['start'], t.deps)).toBe(0);
    const spawns = t.runner.calls.filter((c) => c.kind === 'detached');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe(process.execPath);
    expect(spawns[0]?.args[0]).toMatch(/codex-supervisor\.(ts|js)$/);
    const team = readTeam(t.env);
    if (!team.ok || !team.record) throw new Error('no team');
    const supervisor = team.record.supervisor_pid as number;
    expect(t.runner.living.has(supervisor)).toBe(true);
    expect(team.record.sessions.map((s) => s.name)).toHaveLength(6);

    const job = JSON.parse(readFileSync(spawns[0]?.args[1] as string, 'utf8')) as SupervisorJob;
    expect(job.binary).toBe(join(fixtureBin, 'codex'));
    expect(job.supervisorPid).toBeUndefined();
    const mainJob = job.sessions.find((s) => s.name === 'main');
    expect(mainJob?.args).toEqual([...sandboxedExec([join(t.env.home, '.trellis-crew', 'mailbox')]), mainJob?.args.at(-1)]);
    expect(mainJob?.args.at(-1)).toMatch(/You are main, the lead\.[\s\S]*file mailbox at/);
    expect(t.out.text()).toMatch(/supervisor/);
  });

  it('the supervisor job file goes only into a private state folder', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const { codexAdapter } = await import('../src/adapters/codex.ts');
    const launchAll = codexAdapter.launchAll;
    if (launchAll === undefined) throw new Error('no launchAll');
    chmodSync(join(t.env.home, '.trellis-crew'), 0o755);
    const ctx = { env: t.env, runner: t.runner, binaryPath: join(fixtureBin, 'codex'), out: () => {} };
    // A folder or disk problem is a named step that failed, never a throw.
    expect(await launchAll([{ name: 'main', kickoff: 'k', flagArgs: [] }], ctx, join(t.env.home, 'team.json'))).toEqual({
      ok: false,
      message: expect.stringMatching(/^could not write the supervisor job file .*codex-supervisor\.json: .*open to other users/),
    });
    expect(existsSync(join(t.env.home, '.trellis-crew', 'codex-supervisor.json'))).toBe(false);
    // Only the working-folder check ran.
    expect(t.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
  });

  it('46: each set field prints one warning, and the session still starts', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(t.err.lines.filter((l) => l.startsWith('warning: helper-a:'))).toEqual([
      'warning: helper-a: autocompact ignored. Codex CLI has no verified flag for it.',
      'warning: helper-a: model ignored. Codex CLI has no verified flag for it.',
    ]);
  });

  it('the supervisor waits for its record, starts each child, records the pids, and ends them on stop', async () => {
    const dir = makeFixtureHome();
    const bin = join(dir, 'codex');
    writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
    chmodSync(bin, 0o755);
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, {
      version: 1,
      harness: 'codex',
      supervisor_pid: process.pid,
      sessions: [
        { name: 'main', pid: null, session_id: null },
        { name: 'worker-1', pid: null, session_id: null },
      ],
    });
    const job: SupervisorJob = {
      binary: bin,
      cwd: makeFixtureRepo().root,
      home: dir,
      teamPath,
      sessions: [
        { name: 'main', args: codexExecArgs([], 'kickoff one', dir) },
        { name: 'worker-1', args: codexExecArgs([], 'kickoff two', dir) },
      ],
    };
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: () => {}, vars: FLAG_ON });
    await waitFor(() => {
      const team = readTeamFile(teamPath);
      return team.ok && !!team.record && team.record.sessions.every((s) => s.pid !== null);
    });
    const team = readTeamFile(teamPath);
    if (!team.ok || !team.record) throw new Error('no team');
    const pids = team.record.sessions.map((s) => s.pid as number);
    for (const pid of pids) expect(alive(pid)).toBe(true);
    // Each child's start time is recorded, so stop can tell a reused pid.
    for (const entry of team.record.sessions) expect(processStartTime(entry.pid as number)).toEqual({ status: 'running', started: entry.started });
    handle.stop();
    await handle.done;
    await waitFor(() => pids.every((pid) => !alive(pid)));
  });

  it('the supervisor refuses a child whose arguments lack the exact sandbox, says why, and starts the rest', async () => {
    const dir = makeFixtureHome();
    const bin = join(dir, 'codex');
    writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
    chmodSync(bin, 0o755);
    const teamPath = join(dir, 'team.json');
    const names = ['bare', 'wide', 'flagged', 'good'];
    writeTeamFile(teamPath, {
      version: 1,
      harness: 'codex',
      supervisor_pid: process.pid,
      sessions: names.map((name) => ({ name, pid: null, session_id: null })),
    });
    const good = codexExecArgs([], 'k', dir);
    const job: SupervisorJob = {
      binary: bin,
      cwd: makeFixtureRepo().root,
      home: dir,
      teamPath,
      sessions: [
        { name: 'bare', args: ['exec', 'k'] },
        { name: 'wide', args: good.map((a) => (a === 'workspace-write' ? 'danger-full-access' : a)) },
        { name: 'flagged', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', ...good.slice(1)] },
        { name: 'good', args: good },
      ],
    };
    const warnings: string[] = [];
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line), vars: FLAG_ON });
    await waitFor(() => {
      const team = readTeamFile(teamPath);
      return team.ok && team.record?.sessions.find((s) => s.name === 'good')?.pid !== null;
    });
    const team = readTeamFile(teamPath);
    if (!team.ok || !team.record) throw new Error('no team');
    expect(team.record.sessions.filter((s) => s.pid !== null).map((s) => s.name)).toEqual(['good']);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/^trellis-crew supervisor: bare: refused, so it was not started: .*not the sandbox arguments/);
    expect(warnings[1]).toMatch(/^trellis-crew supervisor: wide: refused/);
    expect(warnings[2]).toMatch(/^trellis-crew supervisor: flagged: refused, so it was not started: .*--dangerously-bypass-approvals-and-sandbox/);
    handle.stop();
    await handle.done;
  });

  it('the supervisor starts nothing when its record never names it', async () => {
    const dir = makeFixtureHome();
    const teamPath = join(dir, 'team.json');
    writeTeamFile(teamPath, { version: 1, harness: 'codex', sessions: [{ name: 'main', pid: null, session_id: null }] });
    const handle = runSupervisor(
      { binary: join(dir, 'missing'), cwd: makeFixtureRepo().root, home: dir, teamPath, sessions: [{ name: 'main', args: ['exec', 'k'] }] },
      { ownPid: process.pid, pollMs: 10, waitMs: 100, vars: FLAG_ON },
    );
    await handle.done;
    const team = readTeamFile(teamPath);
    expect(team.ok && team.record?.sessions[0]?.pid).toBeNull();
  });

  it('install copies each skill folder into ~/.agents/skills, and update copies them fresh', async () => {
    const t = installedOn('codex', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    mkdirSync(join(t.env.home, '.codex'));
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const skills = readdirSync(join(repoRoot, 'skills'));
    const target = join(t.env.home, '.agents', 'skills');
    expect(readdirSync(target).sort()).toEqual(skills.sort());
    for (const skill of skills) {
      expect(readFileSync(join(target, skill, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(repoRoot, 'skills', skill, 'SKILL.md'), 'utf8'));
    }
    writeFileSync(join(target, 'department-lead', 'stale.txt'), 'old');
    writeFileSync(join(target, 'someone-elses-skill.md'), 'keep');
    expect(await main(['update'], t.deps)).toBe(0);
    expect(existsSync(join(target, 'department-lead', 'stale.txt'))).toBe(false);
    expect(existsSync(join(target, 'someone-elses-skill.md'))).toBe(true);
    expect(t.runner.calls).toEqual([]);
  });
});
