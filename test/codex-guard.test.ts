import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.ts';
import { codexExecArgs } from '../src/adapters/codex-args.ts';
import { checkWorkdir, checkWorkdirSync, codexChildEnv, codexMailboxProblem, CODEX_CHILD_ENV } from '../src/adapters/codex-guard.ts';
import { runSupervisor, type SupervisorJob } from '../src/adapters/codex-supervisor.ts';
import type { AdapterContext } from '../src/adapters/types.ts';
import { main } from '../src/cli.ts';
import type { Env } from '../src/env.ts';
import type { RunOptions } from '../src/runner.ts';
import { readTeam, readTeamFile, writeTeamFile } from '../src/store/team-json.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { fixtureBin } from './helpers/paths.ts';
import { isGitCall, recordingRunner } from './helpers/recording-runner.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedOn, writeRoles } from './helpers/team.ts';

/** The supervisor reads the experimental Codex flag from its options here, so these tests set it themselves. */
const FLAG_ON = { TRELLIS_EXPERIMENTAL_CODEX: '1' };

const RULE ='Codex CLI sessions can write their working folder, so trellis-crew starts them only at the top of a git worktree.';

/** The five working folders every place must judge: four refused and one that passes. */
function folders(): { home: string; cases: { name: string; cwd: string; reason: RegExp | null }[] } {
  const home = makeFixtureHome();
  const repo = makeFixtureRepo();
  mkdirSync(join(repo.root, 'sub'));
  const plain = makeFixtureHome();
  return {
    home,
    cases: [
      { name: 'the home folder', cwd: home, reason: /: it is your home folder\.$/ },
      { name: '/', cwd: '/', reason: /^.*\/: it is the root folder\.$/ },
      { name: 'a folder that is not a repo', cwd: plain, reason: /: it is not in a git worktree \(.*not a git repository.*\)\.$/ },
      { name: 'a subfolder of a repo', cwd: join(repo.root, 'sub'), reason: /: it is not the top of a git worktree\. The top is .+\.$/ },
      { name: 'a valid worktree top', cwd: repo.root, reason: null },
    ],
  };
}

function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > until) return reject(new Error('timed out waiting'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('the Codex working folder: checkWorkdir through the injected runner', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`judges ${name}`, async () => {
      const { home } = folders();
      const env = makeTestEnv({ home: name === 'the home folder' ? cwd : home, cwd });
      const runner = recordingRunner();
      const problem = await checkWorkdir(env, runner);
      if (reason === null) expect(problem).toBeUndefined();
      else {
        expect(problem?.startsWith(`${RULE} `)).toBe(true);
        expect(problem).toMatch(reason);
      }
    });
  }

  it('runs git rev-parse --show-toplevel through the runner, in the folder', async () => {
    const repo = makeFixtureRepo();
    const env = makeTestEnv({ cwd: repo.root });
    const runner = recordingRunner();
    expect(await checkWorkdir(env, runner)).toBeUndefined();
    expect(runner.calls).toEqual([
      { kind: 'run', command: join(fixtureBin, 'git'), args: ['rev-parse', '--show-toplevel'] },
      { kind: 'run', command: join(fixtureBin, 'git'), args: ['config', '--list', '--show-origin', '--includes', '-z'] },
    ]);
  });

  it('refuses when git is not on PATH', async () => {
    const repo = makeFixtureRepo();
    const env = makeTestEnv({ cwd: repo.root, path: join(repo.root, 'no-bin') });
    expect(await checkWorkdir(env, recordingRunner())).toMatch(/not in a git worktree \(git is not on PATH\)/);
  });
});

describe('the Codex working folder: checkWorkdirSync, for the supervisor', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`judges ${name}`, () => {
      const { home } = folders();
      const problem = checkWorkdirSync(cwd, name === 'the home folder' ? cwd : home);
      if (reason === null) expect(problem).toBeUndefined();
      else expect(problem).toMatch(reason);
    });
  }
});

function ctxFor(env: Env, mailbox?: string): AdapterContext & { runner: ReturnType<typeof recordingRunner> } {
  return { env, runner: recordingRunner(), binaryPath: join(fixtureBin, 'codex'), out: () => {}, ...(mailbox === undefined ? {} : { mailbox }) };
}

describe('the Codex working folder: the adapter refuses before it writes the job or starts a session', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`launchAll and launch judge ${name}`, async () => {
      const { home } = folders();
      const env = makeTestEnv({ home: name === 'the home folder' ? cwd : home, cwd });
      const mailbox = join(env.home, '.trellis-crew', 'mailbox');
      const all = ctxFor(env, mailbox);
      const outcome = await codexAdapter.launchAll?.([{ name: 'main', kickoff: 'k', flagArgs: [] }], all, join(env.home, 'team.json'));
      const one = ctxFor(env, mailbox);
      const single = await codexAdapter.launch('main', 'k', [], one);
      if (reason === null) {
        expect(outcome).toMatchObject({ ok: true });
        expect(single).toMatchObject({ ok: true });
        return;
      }
      expect(outcome).toEqual({ ok: false, message: expect.stringMatching(reason) });
      expect(single).toEqual({ ok: false, message: expect.stringMatching(reason) });
      expect(existsSync(join(env.home, '.trellis-crew', 'codex-supervisor.json'))).toBe(false);
      expect(all.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
      expect(one.runner.calls.filter((c) => !isGitCall(c))).toEqual([]);
    });
  }

  it('start from the home folder starts nothing on Codex', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const deps = { ...t.deps, env: { ...t.env, cwd: t.env.home } };
    expect(await main(['start'], deps)).toBe(1);
    expect(t.err.text()).toContain(RULE);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toEqual([]);
    expect(readTeam(t.env)).toEqual({ ok: true, record: undefined });
  });
});

function supervisorRig(cwd: string, home: string) {
  const dir = makeFixtureHome();
  const bin = join(dir, 'codex');
  writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n');
  chmodSync(bin, 0o755);
  const teamPath = join(dir, 'team.json');
  writeTeamFile(teamPath, { version: 1, harness: 'codex', supervisor_pid: process.pid, sessions: [{ name: 'main', pid: null, session_id: null }] });
  const job: SupervisorJob = { binary: bin, cwd, home, teamPath, sessions: [{ name: 'main', args: codexExecArgs([], 'k', undefined) }] };
  return { job, teamPath };
}

describe('the Codex working folder: the supervisor refuses before it starts any child', () => {
  for (const { name, cwd, reason } of folders().cases) {
    it(`judges ${name}`, async () => {
      const { home } = folders();
      const { job, teamPath } = supervisorRig(cwd, name === 'the home folder' ? cwd : home);
      const warnings: string[] = [];
      const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line), vars: FLAG_ON });
      if (reason === null) {
        await waitFor(() => {
          const team = readTeamFile(teamPath);
          return team.ok && team.record?.sessions[0]?.pid !== null;
        });
        expect(warnings).toEqual([]);
        handle.stop();
        await handle.done;
        return;
      }
      await handle.done;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^trellis-crew supervisor: refused to start any session: Codex CLI sessions can write their working folder/);
      expect(warnings[0]).toMatch(reason);
      const team = readTeamFile(teamPath);
      expect(team.ok && team.record?.sessions[0]?.pid).toBeNull();
    });
  }

  it('the default report writes the reason to codex-supervisor.log beside the team record', async () => {
    const home = makeFixtureHome();
    const { job, teamPath } = supervisorRig(home, home);
    // The default report also writes the line to standard error, so this test prints it once.
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, vars: FLAG_ON });
    await handle.done;
    expect(readFileSync(join(dirname(teamPath), 'codex-supervisor.log'), 'utf8')).toMatch(/refused to start any session: .*it is your home folder\./);
  });
});

describe('the Codex working folder holds no other git repository, at depth 1 to 3', () => {
  /** A repo top with one more repository made at `inner`, a path relative to the top. */
  function nestedAt(inner: string) {
    const repo = makeFixtureRepo();
    mkdirSync(join(repo.root, dirname(inner)), { recursive: true });
    repo.git('init', '-q', inner);
    return repo;
  }

  const both = async (cwd: string): Promise<[string | undefined, string | undefined]> => [
    await checkWorkdir(makeTestEnv({ cwd }), recordingRunner()),
    checkWorkdirSync(cwd, makeFixtureHome()),
  ];

  it('refuses a nested clone at depth 1 and at depth 3, and names it', async () => {
    for (const [inner, shown] of [['inner', 'inner'], [join('a', 'b', 'inner'), join('a', 'b', 'inner')]]) {
      const repo = nestedAt(inner as string);
      for (const problem of await both(repo.root)) {
        expect(problem).toMatch(new RegExp(`^${RULE.replace(/[.]/g, '\\.')} .*: it holds another git repository at ${shown}\\.$`));
      }
    }
  });

  it('passes a nested clone at depth 4, which is past the bound', async () => {
    const repo = nestedAt(join('a', 'b', 'c', 'inner'));
    expect(await both(repo.root)).toEqual([undefined, undefined]);
  });

  it('refuses a .git file at depth 2, as a worktree or submodule leaves one', async () => {
    const repo = makeFixtureRepo();
    repo.write(join('a', 'sub', '.git'), 'gitdir: ../../elsewhere\n');
    for (const problem of await both(repo.root)) expect(problem).toMatch(/: it holds another git repository at a\/sub\.$/);
  });

  it('never follows a symbolic link, so a link to a repository passes', async () => {
    const repo = makeFixtureRepo();
    const other = makeFixtureRepo();
    symlinkSync(other.root, join(repo.root, 'linked'));
    symlinkSync(join(other.root, '.git'), join(repo.root, 'dot-git-link'));
    expect(await both(repo.root)).toEqual([undefined, undefined]);
  });

  it('passes a clean worktree top, and does not look inside its own .git', async () => {
    const repo = makeFixtureRepo();
    repo.write(join('src', 'deep', 'er', 'file.txt'), 'x');
    repo.commit('one');
    expect(await both(repo.root)).toEqual([undefined, undefined]);
  });

  it.skipIf(process.getuid?.() === 0)('refuses a folder below the top that cannot be read, and names it', async () => {
    const repo = makeFixtureRepo();
    mkdirSync(join(repo.root, 'open', 'locked'), { recursive: true });
    chmodSync(join(repo.root, 'open', 'locked'), 0o000);
    try {
      for (const problem of await both(repo.root)) {
        expect(problem).toMatch(/: a folder below it cannot be read, so it cannot be checked for other git repositories: open\/locked \(EACCES\)\.$/);
      }
    } finally {
      chmodSync(join(repo.root, 'open', 'locked'), 0o755);
    }
  });

  it('every place refuses it: up, launchAll before the job write, launch, and the supervisor', async () => {
    const t = installedOn('codex', 'file-mailbox');
    mkdirSync(join(t.env.cwd, 'vendor'));
    execFileSync('git', ['init', '-q', join(t.env.cwd, 'vendor', 'lib')]);
    const reason = /: it holds another git repository at vendor\/lib\./;

    expect(await main(['up', '--harness', 'codex', '--yes'], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(reason);
    expect(t.out.text()).not.toContain('Step 1 of 2');

    const mailbox = join(t.env.home, '.trellis-crew', 'mailbox');
    const all = ctxFor(t.env, mailbox);
    expect(await codexAdapter.launchAll?.([{ name: 'main', kickoff: 'k', flagArgs: [] }], all, join(t.env.home, 'team.json'))).toEqual({
      ok: false,
      message: expect.stringMatching(reason),
    });
    expect(existsSync(join(t.env.home, '.trellis-crew', 'codex-supervisor.json'))).toBe(false);
    const one = ctxFor(t.env, mailbox);
    expect(await codexAdapter.launch('main', 'k', [], one)).toEqual({ ok: false, message: expect.stringMatching(reason) });
    expect([...all.runner.calls, ...one.runner.calls].filter((c) => !isGitCall(c))).toEqual([]);

    const { job, teamPath } = supervisorRig(t.env.cwd, t.env.home);
    const warnings: string[] = [];
    await runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line), vars: FLAG_ON }).done;
    expect(warnings).toEqual([expect.stringMatching(reason)]);
    expect(readTeamFile(teamPath)).toMatchObject({ ok: true, record: { sessions: [{ pid: null }] } });
  });
});

describe('the Codex working folder does not hold its own git hooks folder', () => {
  const both = async (cwd: string, home = makeFixtureHome()): Promise<[string | undefined, string | undefined]> => [
    await checkWorkdir(makeTestEnv({ cwd, home }), recordingRunner()),
    checkWorkdirSync(cwd, home),
  ];
  const inside = /: core\.hooksPath is .*, which resolves to .*, inside the working folder, so a session could write a git hook\.$/;

  it('passes an unset core.hooksPath, and the folder keeps its own .git', async () => {
    const repo = makeFixtureRepo();
    expect(existsSync(join(repo.root, '.git'))).toBe(true);
    expect(await both(repo.root)).toEqual([undefined, undefined]);
  });

  it('refuses a relative .githooks inside the repo', async () => {
    const repo = makeFixtureRepo();
    repo.git('config', 'core.hooksPath', '.githooks');
    mkdirSync(join(repo.root, '.githooks'));
    for (const problem of await both(repo.root)) {
      expect(problem).toMatch(inside);
      expect(problem).toContain('core.hooksPath is .githooks');
    }
  });

  it('refuses an absolute path inside the repo', async () => {
    const repo = makeFixtureRepo();
    repo.git('config', 'core.hooksPath', join(repo.root, 'tools', 'hooks'));
    mkdirSync(join(repo.root, 'tools', 'hooks'), { recursive: true });
    for (const problem of await both(repo.root)) expect(problem).toMatch(inside);
  });

  it('refuses a path that does not exist yet but would sit inside the repo', async () => {
    const repo = makeFixtureRepo();
    repo.git('config', 'core.hooksPath', join('not', 'yet', 'hooks'));
    for (const problem of await both(repo.root)) expect(problem).toMatch(inside);
  });

  it('resolves a leading ~/ against the home folder', async () => {
    const repo = makeFixtureRepo();
    const home = dirname(repo.root);
    repo.git('config', 'core.hooksPath', `~/${basename(repo.root)}/hooks`);
    for (const problem of await both(repo.root, home)) expect(problem).toMatch(inside);
  });

  it('passes a path outside the repo', async () => {
    const repo = makeFixtureRepo();
    repo.git('config', 'core.hooksPath', join(makeFixtureHome(), 'hooks'));
    expect(await both(repo.root)).toEqual([undefined, undefined]);
  });

  it('refuses when git config fails in any way, or its answer cannot be read', async () => {
    const repo = makeFixtureRepo();
    for (const [answerOf, reason] of [
      [{ code: 128, stdout: '', stderr: 'fatal: bad config line 1\n', timedOut: false }, /\(fatal: bad config line 1\)\.$/],
      [{ code: 1, stdout: '', stderr: '', timedOut: false }, /\(exit code 1\)\.$/],
      [{ code: 0, stdout: 'file:.git/config\0core.bare\nfalse', stderr: '', timedOut: false }, /\(its answer cannot be read\)\.$/],
    ] as const) {
      const runner = recordingRunner();
      const answer = runner.run.bind(runner);
      runner.run = async (command, args, options) => (args[0] === 'config' ? answerOf : answer(command, args, options));
      const problem = await checkWorkdir(makeTestEnv({ cwd: repo.root }), runner);
      expect(problem).toMatch(/: git config --list failed, so git's settings cannot be checked /);
      expect(problem).toMatch(reason);
    }
  });

  it('every place refuses it: up, launchAll before the job write, launch, and the supervisor', async () => {
    const t = installedOn('codex', 'file-mailbox');
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: t.env.cwd });
    expect(await main(['up', '--harness', 'codex', '--yes'], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/core\.hooksPath is \.githooks/);
    expect(t.out.text()).not.toContain('Step 1 of 2');

    const mailbox = join(t.env.home, '.trellis-crew', 'mailbox');
    const all = ctxFor(t.env, mailbox);
    expect(await codexAdapter.launchAll?.([{ name: 'main', kickoff: 'k', flagArgs: [] }], all, join(t.env.home, 'team.json'))).toEqual({
      ok: false,
      message: expect.stringMatching(inside),
    });
    expect(existsSync(join(t.env.home, '.trellis-crew', 'codex-supervisor.json'))).toBe(false);
    expect(await codexAdapter.launch('main', 'k', [], ctxFor(t.env, mailbox))).toEqual({ ok: false, message: expect.stringMatching(inside) });

    const { job } = supervisorRig(t.env.cwd, t.env.home);
    const warnings: string[] = [];
    await runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: (line) => warnings.push(line), vars: FLAG_ON }).done;
    expect(warnings).toEqual([expect.stringMatching(inside)]);
  });
});

describe('the Codex working folder feeds git no config file or fsmonitor command from inside it', () => {
  const both = async (cwd: string, home = makeFixtureHome()): Promise<[string | undefined, string | undefined]> => [
    await checkWorkdir(makeTestEnv({ cwd, home }), recordingRunner()),
    checkWorkdirSync(cwd, home),
  ];
  const fileInside = (file: string, key: string) =>
    new RegExp(`: git reads the config file .*${file.replace(/[.]/g, '\\.')}, for the key ${key.replace(/[.]/g, '\\.')}, and that file sits inside the working folder\\.$`);

  it('refuses an include.path to a file inside the folder, even one that sets nothing dangerous', async () => {
    const withKey = makeFixtureRepo();
    withKey.write('shared.cfg', '[user]\n\tname = fixture\n');
    withKey.git('config', 'include.path', '../shared.cfg');
    for (const problem of await both(withKey.root)) expect(problem).toMatch(fileInside('shared.cfg', 'include.path'));

    // An empty file adds no entry of its own, so the include itself is what is refused.
    const empty = makeFixtureRepo();
    empty.write('empty.cfg', '');
    empty.git('config', 'include.path', '../empty.cfg');
    for (const problem of await both(empty.root)) expect(problem).toMatch(fileInside('empty.cfg', 'include.path'));
  });

  it('refuses an includeIf gitdir: include inside the folder', async () => {
    const repo = makeFixtureRepo();
    repo.write(join('conf', 'if.cfg'), '[user]\n\temail = fixture@example.invalid\n');
    repo.git('config', `includeIf.gitdir:${repo.root}/.path`, '../conf/if.cfg');
    for (const problem of await both(repo.root)) expect(problem).toMatch(/: git reads the config file .*conf\/if\.cfg, for the key includeif\.gitdir:.*\.path, and that file sits inside the working folder\.$/);
  });

  it('passes an include inside the folder\'s own .git, and an include outside the repo', async () => {
    const inGit = makeFixtureRepo();
    inGit.write(join('.git', 'extra.cfg'), '[user]\n\tname = fixture\n');
    inGit.git('config', 'include.path', 'extra.cfg');
    expect(await both(inGit.root)).toEqual([undefined, undefined]);

    const outside = makeFixtureRepo();
    const elsewhere = join(makeFixtureHome(), 'shared.cfg');
    writeFileSync(elsewhere, '[user]\n\tname = fixture\n');
    outside.git('config', 'include.path', elsewhere);
    expect(await both(outside.root)).toEqual([undefined, undefined]);
  });

  it('refuses a core.fsmonitor path inside the folder, and passes true and a path outside', async () => {
    const inside = makeFixtureRepo();
    inside.git('config', 'core.fsmonitor', join('tools', 'watch'));
    for (const problem of await both(inside.root)) {
      expect(problem).toMatch(commandInside('core.fsmonitor', 'tools/watch', 'tools/watch'));
    }
    for (const value of ['true', 'false', 'yes', 'no', 'on', 'off', '1', '0', 'TRUE']) {
      const repo = makeFixtureRepo();
      repo.git('config', 'core.fsmonitor', value);
      expect(await both(repo.root)).toEqual([undefined, undefined]);
    }
    const outside = makeFixtureRepo();
    outside.git('config', 'core.fsmonitor', join(makeFixtureHome(), 'watch'));
    expect(await both(outside.root)).toEqual([undefined, undefined]);
  });

  it('still refuses an empty core.fsmonitor, and a ~user path in it', async () => {
    const empty = makeFixtureRepo();
    empty.git('config', 'core.fsmonitor', '');
    for (const problem of await both(empty.root)) expect(problem).toMatch(/: core\.fsmonitor is empty, so it cannot be checked\.$/);
    const other = makeFixtureRepo();
    other.git('config', 'core.fsmonitor', '~someone/watch');
    for (const problem of await both(other.root)) expect(problem).toMatch(/: core\.fsmonitor is ~someone\/watch, which names another user's home folder, so it cannot be checked\.$/);
  });
});

/** A table test spawns about ten git processes per case, so it gets more than the default five seconds. */
const TABLE_TIMEOUT_MS = 30_000;

/** The refusal for a command key whose path word resolves inside the working folder. */
function commandInside(key: string, value: string, word: string): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `: ${escape(key)} is ${escape(value)}, and the path ${escape(word)} in it resolves to .*, inside the working folder, so a session could write the command git runs\\.$`,
  );
}

describe('the Codex working folder: a command git runs names no path inside it', () => {
  const both = async (cwd: string, home = makeFixtureHome()): Promise<[string | undefined, string | undefined]> => [
    await checkWorkdir(makeTestEnv({ cwd, home }), recordingRunner()),
    checkWorkdirSync(cwd, home),
  ];
  const withConfig = (key: string, value: string) => {
    const repo = makeFixtureRepo();
    repo.git('config', key, value);
    return repo;
  };

  it('refuses an in-tree path in every listed key, and passes the same key with a path outside', async () => {
    const outside = join(makeFixtureHome(), 'x');
    const keys = [
      'core.fsmonitor', 'core.sshCommand', 'core.editor', 'core.pager', 'core.askPass', 'core.gitProxy', 'sequence.editor',
      'pager.log', 'filter.Lfs.clean', 'filter.Lfs.smudge', 'filter.Lfs.process', 'diff.external', 'diff.Word.textconv',
      'diff.Word.command', 'merge.Ours.driver', 'difftool.Meld.cmd', 'mergetool.Meld.cmd', 'gpg.program', 'gpg.ssh.program',
      'credential.helper', 'credential.https://example.com.helper', 'remote.origin.uploadpack', 'remote.origin.receivepack',
    ];
    // One repo for the whole table: each case sets the key, checks, and unsets it again.
    const repo = makeFixtureRepo();
    for (const key of keys) {
      const shown = key.replace(/^([^.]+)\./, (_m, section: string) => `${section.toLowerCase()}.`).replace(/\.([^.]+)$/, (_m, name: string) => `.${name.toLowerCase()}`);
      repo.git('config', key, './tools/x');
      for (const problem of await both(repo.root)) expect(problem).toMatch(commandInside(shown, './tools/x', './tools/x'));
      repo.git('config', key, outside);
      expect(await both(repo.root)).toEqual([undefined, undefined]);
      repo.git('config', '--unset', key);
    }
  }, TABLE_TIMEOUT_MS);

  it('refuses an interpreter with an in-tree script, as a shell reads it', async () => {
    const repo = withConfig('core.fsmonitor', '/bin/sh tools/fsmon.sh');
    for (const problem of await both(repo.root)) expect(problem).toMatch(commandInside('core.fsmonitor', '/bin/sh tools/fsmon.sh', 'tools/fsmon.sh'));
  });

  it('refuses a $(cat tools/x) form', async () => {
    const repo = withConfig('core.editor', 'vi $(cat tools/x)');
    for (const problem of await both(repo.root)) expect(problem).toMatch(commandInside('core.editor', 'vi $(cat tools/x)', 'tools/x'));
  });

  it('refuses a shell alias with !./x, and passes a git alias', async () => {
    const shell = withConfig('alias.go', '!./x');
    for (const problem of await both(shell.root)) expect(problem).toMatch(commandInside('alias.go', '!./x', './x'));
    const plain = withConfig('alias.lg', 'log --oneline ./docs');
    expect(await both(plain.root)).toEqual([undefined, undefined]);
  });

  it('passes a filter such as git-lfs clean -- %f, and other words with no /', async () => {
    expect(await both(withConfig('filter.lfs.clean', 'git-lfs clean -- %f').root)).toEqual([undefined, undefined]);
    expect(await both(withConfig('core.pager', 'less -R').root)).toEqual([undefined, undefined]);
  });

  it('refuses core.sshcommand with ssh -i ./keys/id', async () => {
    const repo = withConfig('core.sshCommand', 'ssh -i ./keys/id');
    for (const problem of await both(repo.root)) expect(problem).toMatch(commandInside('core.sshcommand', 'ssh -i ./keys/id', './keys/id'));
  });

  it('passes credential.helper=store, and refuses credential.helper=!./bin/cred', async () => {
    expect(await both(withConfig('credential.helper', 'store').root)).toEqual([undefined, undefined]);
    const repo = withConfig('credential.helper', '!./bin/cred');
    for (const problem of await both(repo.root)) expect(problem).toMatch(commandInside('credential.helper', '!./bin/cred', './bin/cred'));
  });

  it('splits at each shell character, so a quoted or chained path is still seen', async () => {
    for (const [value, word] of [
      ["sh -c 'tools/a'", 'tools/a'],
      ['echo x;tools/b', 'tools/b'],
      ['a|tools/c', 'tools/c'],
      ['`tools/d`', 'tools/d'],
      ['a&&tools/e', 'tools/e'],
      ['{tools/f}', 'tools/f'],
      ['a<tools/g', 'tools/g'],
      ['"tools/h"', 'tools/h'],
      ['.hidden', '.hidden'],
    ]) {
      const repo = withConfig('core.pager', value as string);
      for (const problem of await both(repo.root)) expect(problem).toMatch(commandInside('core.pager', value as string, word as string));
    }
  }, TABLE_TIMEOUT_MS);

  it('resolves ~/ against the home folder, and refuses ~user', async () => {
    const repo = makeFixtureRepo();
    repo.git('config', 'core.pager', `less ~/${basename(repo.root)}/tools/p`);
    for (const problem of await both(repo.root, dirname(repo.root))) {
      expect(problem).toMatch(commandInside('core.pager', `less ~/${basename(repo.root)}/tools/p`, `~/${basename(repo.root)}/tools/p`));
    }
    const other = withConfig('core.pager', 'less ~someone/p');
    for (const problem of await both(other.root)) {
      expect(problem).toMatch(/: core\.pager is less ~someone\/p, which names another user's home folder, so it cannot be checked\.$/);
    }
  });
});

/** The refusal for an interpreter whose next word is not an absolute path outside the working folder. */
function interpreterRefused(key: string, value: string, interpreter: string, next: string | null): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const after = next === null ? 'nothing after it' : `${escape(next)} after it`;
  return new RegExp(
    `: ${escape(key)} is ${escape(value)}, and the interpreter ${escape(interpreter)} in it has ${after}, not an absolute path outside the working folder, so it cannot be checked\\.$`,
  );
}

describe('the Codex working folder: an interpreter in a command must run a script outside it', () => {
  const both = async (cwd: string, home = makeFixtureHome()): Promise<[string | undefined, string | undefined]> => [
    await checkWorkdir(makeTestEnv({ cwd, home }), recordingRunner()),
    checkWorkdirSync(cwd, home),
  ];
  const withConfig = (key: string, value: string) => {
    const repo = makeFixtureRepo();
    repo.git('config', key, value);
    return repo;
  };
  const expectRefused = async (key: string, value: string, interpreter: string, next: string | null, shown = key) => {
    for (const problem of await both(withConfig(key, value).root)) expect(problem).toMatch(interpreterRefused(shown, value, interpreter, next));
  };

  it('refuses an interpreter with a bare script name, since git runs it in the working folder', async () => {
    await expectRefused('core.fsmonitor', 'sh fsmon.sh', 'sh', 'fsmon.sh');
    await expectRefused('filter.x.clean', 'node clean.js', 'node', 'clean.js');
    await expectRefused('alias.go', '!sh go.sh', 'sh', 'go.sh');
  });

  it('looks past env and its VAR=value words', async () => {
    await expectRefused('core.editor', '/usr/bin/env python3 x.py', 'python3', 'x.py');
    await expectRefused('core.editor', 'env FOO=1 BAR=2 python3.12 x.py', 'python3.12', 'x.py');
  });

  it('refuses an option after the interpreter, and an interpreter as the last word, which fails closed', async () => {
    await expectRefused('core.pager', 'python3 -m foo', 'python3', '-m');
    await expectRefused('core.pager', 'sh -c ls', 'sh', '-c');
    await expectRefused('core.pager', 'less | sh', 'sh', null);
  });

  it('knows every listed shell and runtime, by base name, and python with any suffix', async () => {
    const names = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'python', 'python3', 'python3.12'];
    const repo = makeFixtureRepo();
    for (const name of names) {
      const value = `/usr/local/bin/${name} run.x`;
      repo.git('config', 'core.pager', value);
      for (const problem of await both(repo.root)) expect(problem).toMatch(interpreterRefused('core.pager', value, `/usr/local/bin/${name}`, 'run.x'));
      repo.git('config', 'core.pager', `/usr/local/bin/${name} /opt/outside/x`);
      expect(await both(repo.root)).toEqual([undefined, undefined]);
    }
  }, TABLE_TIMEOUT_MS);

  it('passes an interpreter that runs an absolute script outside the folder, and refuses one inside', async () => {
    expect(await both(withConfig('core.fsmonitor', '/bin/sh /opt/outside/x.sh').root)).toEqual([undefined, undefined]);
    const repo = makeFixtureRepo();
    repo.git('config', 'core.fsmonitor', `/bin/sh ${join(repo.root, 'x.sh')}`);
    for (const problem of await both(repo.root)) expect(problem).toMatch(/: core\.fsmonitor is .*, and the path .*x\.sh in it resolves to .*, inside the working folder/);
  });

  it('matches a dotted alias that starts with !, and passes one that does not', async () => {
    for (const problem of await both(withConfig('alias.a.b', '!./x').root)) expect(problem).toMatch(commandInside('alias.a.b', '!./x', './x'));
    expect(await both(withConfig('alias.a.b', 'log ./x').root)).toEqual([undefined, undefined]);
  });
});

describe('the Codex working folder: the added command keys', () => {
  const both = async (cwd: string, home = makeFixtureHome()): Promise<[string | undefined, string | undefined]> => [
    await checkWorkdir(makeTestEnv({ cwd, home }), recordingRunner()),
    checkWorkdirSync(cwd, home),
  ];
  const withConfig = (key: string, value: string) => {
    const repo = makeFixtureRepo();
    repo.git('config', key, value);
    return repo;
  };
  const lower = (key: string) =>
    key.replace(/^([^.]+)\./, (_m, section: string) => `${section.toLowerCase()}.`).replace(/\.([^.]+)$/, (_m, name: string) => `.${name.toLowerCase()}`);

  it('refuses ./tools/x in each added key, and passes a path outside', async () => {
    const outside = join(makeFixtureHome(), 'x');
    const keys = [
      'gpg.ssh.defaultKeyCommand', 'browser.Firefox.cmd', 'man.Woman.cmd',
      'sendemail.smtpServer', 'sendemail.sendmailCmd', 'sendemail.toCmd', 'sendemail.ccCmd',
      'sendemail.Work.smtpServer', 'sendemail.Work.sendmailCmd', 'sendemail.Work.toCmd', 'sendemail.Work.ccCmd',
      'trailer.Sign.command', 'trailer.Sign.cmd', 'core.alternateRefsCommand',
    ];
    const repo = makeFixtureRepo();
    for (const key of keys) {
      repo.git('config', key, './tools/x');
      for (const problem of await both(repo.root)) expect(problem).toMatch(commandInside(lower(key), './tools/x', './tools/x'));
      repo.git('config', key, outside);
      expect(await both(repo.root)).toEqual([undefined, undefined]);
      repo.git('config', '--unset', key);
    }
  }, TABLE_TIMEOUT_MS);

  it('checks submodule.*.update only when it starts with !, so checkout and rebase pass', async () => {
    for (const problem of await both(withConfig('submodule.Lib.update', '!./tools/x').root)) {
      expect(problem).toMatch(commandInside('submodule.Lib.update', '!./tools/x', './tools/x'));
    }
    for (const problem of await both(withConfig('submodule.Lib.update', '!sh up.sh').root)) {
      expect(problem).toMatch(interpreterRefused('submodule.Lib.update', '!sh up.sh', 'sh', 'up.sh'));
    }
    expect(await both(withConfig('submodule.Lib.update', `!${join(makeFixtureHome(), 'x')}`).root)).toEqual([undefined, undefined]);
    for (const plain of ['checkout', 'rebase', 'merge', 'none']) {
      expect(await both(withConfig('submodule.Lib.update', plain).root)).toEqual([undefined, undefined]);
    }
  });
});

describe('the working-folder check runs git with no GIT_ variable', () => {
  const planted = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: '/nonexistent-git-dir' };
  const hooksInside = /: core\.hooksPath is \.githooks, which resolves to .*, inside the working folder/;

  it('the runner port strips every GIT_ variable, so a repo hooksPath is still found and refused', async () => {
    const repo = makeFixtureRepo();
    repo.git('config', 'core.hooksPath', '.githooks');
    const env = makeTestEnv({ cwd: repo.root });
    const runner = recordingRunner();
    const answer = runner.run.bind(runner);
    const seen: RunOptions['env'][] = [];
    runner.run = async (command, args, options) => {
      seen.push(options?.env);
      return answer(command, args, options);
    };
    expect(await checkWorkdir({ ...env, vars: { ...env.vars, ...planted } }, runner)).toMatch(hooksInside);
    expect(seen).toHaveLength(2);
    for (const vars of seen) {
      expect(Object.keys(vars ?? {}).filter((key) => key.startsWith('GIT_'))).toEqual([]);
      expect(vars).toEqual(env.vars);
    }
  });

  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the supervisor strips every GIT_ variable from its own environment for git', () => {
    // The repo is made first, so no fixture git call sees the planted variables.
    const repo = makeFixtureRepo();
    repo.git('config', 'core.hooksPath', '.githooks');
    const home = makeFixtureHome();
    for (const [key, value] of Object.entries(planted)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    expect(checkWorkdirSync(repo.root, home)).toMatch(hooksInside);
  });
});

describe('the Codex mailbox is a folder inside the state folder', () => {
  function envAt(): Env {
    const home = makeFixtureHome();
    mkdirSync(join(home, '.trellis-crew'), { mode: 0o700 });
    return makeTestEnv({ home, cwd: makeFixtureRepo().root });
  }

  it('accepts the default mailbox and another folder inside the state folder, even before it exists', () => {
    const env = envAt();
    expect(codexMailboxProblem(join(env.home, '.trellis-crew', 'mailbox'), env)).toBeUndefined();
    expect(codexMailboxProblem(join(env.home, '.trellis-crew', 'team', 'mail'), env)).toBeUndefined();
  });

  it('refuses /, the home folder, the state folder and its parents, a parent of the working folder, and anything outside', () => {
    const env = envAt();
    const state = join(env.home, '.trellis-crew');
    const inside = makeTestEnv({ home: env.home, cwd: join(state, 'mail', 'project') });
    mkdirSync(inside.cwd, { recursive: true });
    const cases: [string, Env, RegExp][] = [
      ['/', env, /\/: it is the root folder\.$/],
      [env.home, env, /: it is your home folder\.$/],
      [state, env, /: it is the state folder itself\.$/],
      [dirname(env.home), env, /: it holds the state folder\.$/],
      [join(state, 'mail'), inside, /: it holds the working folder\.$/],
      [inside.cwd, inside, /: it holds the working folder\.$/],
      [join(makeFixtureHome(), 'mail'), env, /: it is outside the state folder\.$/],
    ];
    for (const [mailbox, at, reason] of cases) {
      const problem = codexMailboxProblem(mailbox, at);
      expect(problem).toMatch(/^The file mailbox on Codex CLI must be a folder inside .*\.trellis-crew, because every session can write it\. /);
      expect(problem).toMatch(reason);
    }
  });

  it('follows a symbolic link inside the state folder to where it points', () => {
    const env = envAt();
    const outside = makeFixtureHome();
    symlinkSync(outside, join(env.home, '.trellis-crew', 'link'));
    expect(codexMailboxProblem(join(env.home, '.trellis-crew', 'link', 'mail'), env)).toMatch(/it is outside the state folder/);
  });

  it('start on Codex refuses a roles file that names an outside mailbox, and creates no folder there', async () => {
    const t = installedOn('codex', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/team-mail'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(2);
    expect(t.err.text()).toMatch(/The file mailbox on Codex CLI must be a folder inside .*: it is outside the state folder\./);
    expect(existsSync(join(t.env.home, 'team-mail'))).toBe(false);
    expect(t.runner.calls.filter((c) => c.kind === 'detached')).toEqual([]);
  });

  it('other harnesses keep an outside mailbox, as before', async () => {
    const t = installedOn('qwen-code', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/team-mail'));
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    expect(existsSync(join(t.env.home, 'team-mail'))).toBe(true);
  });
});

describe('the Codex child environment is an allowlist', () => {
  const listed = Object.fromEntries(CODEX_CHILD_ENV.map((key) => [key, `v-${key}`]));

  it('keeps each listed variable and drops every other one, with every other CODEX_ variable', () => {
    expect(CODEX_CHILD_ENV).toEqual([
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'OPENAI_API_KEY', 'CODEX_HOME',
    ]);
    expect(codexChildEnv({ ...listed, CODEX_SANDBOX: 'seatbelt', CODEX_OTHER: 'x', SECRET_X: 's', UNSET: undefined })).toEqual(listed);
  });

  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the supervisor starts each child with the allowlist only', async () => {
    for (const key of ['SECRET_X', 'CODEX_SANDBOX', 'OPENAI_API_KEY', 'LANG']) saved[key] = process.env[key];
    process.env.SECRET_X = 'secret';
    process.env.CODEX_SANDBOX = 'seatbelt';
    process.env.OPENAI_API_KEY = 'fixture-key';
    process.env.LANG = 'C';
    const repo = makeFixtureRepo();
    const { job, teamPath } = supervisorRig(repo.root, makeFixtureHome());
    const out = join(dirname(teamPath), 'child-env.txt');
    writeFileSync(job.binary, `#!/bin/sh\n/usr/bin/env > '${out}'\nexec /bin/sleep 30\n`);
    const handle = runSupervisor(job, { ownPid: process.pid, pollMs: 10, warn: () => {}, vars: FLAG_ON });
    await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').includes('LANG='));
    const lines = readFileSync(out, 'utf8').split('\n');
    expect(lines).toContain('OPENAI_API_KEY=fixture-key');
    expect(lines).toContain('LANG=C');
    expect(lines.some((line) => line.startsWith('SECRET_X='))).toBe(false);
    expect(lines.some((line) => line.startsWith('CODEX_SANDBOX='))).toBe(false);
    handle.stop();
    await handle.done;
  });

  it('respawn starts its one session with the allowlist only', async () => {
    const repo = makeFixtureRepo();
    const env = makeTestEnv({ cwd: repo.root, vars: { ...listed, SECRET_X: 's', CODEX_SANDBOX: 'seatbelt' } });
    const ctx = ctxFor(env, join(env.home, '.trellis-crew', 'mailbox'));
    let seen: RunOptions['env'];
    ctx.runner.spawnDetached = async (_command, _args, options) => {
      seen = options?.env;
      return { pid: 41000 };
    };
    expect(await codexAdapter.launch('main', 'k', [], ctx)).toMatchObject({ ok: true });
    expect(seen).toEqual(listed);
  });
});
