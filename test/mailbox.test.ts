import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAILBOX, ensureMailboxFolder, mailboxPath } from '../src/mailbox/folder.ts';
import { main } from '../src/cli.ts';
import { parentFolderProblem, privateFolderProblem } from '../src/fs-private.ts';
import { defaultTeam } from '../src/roles/defaults.ts';
import { writeInstallRecord } from '../src/store/install-yml.ts';
import { writeTeam } from '../src/store/team-json.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { repoRoot } from './helpers/paths.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { gitRunner } from './helpers/git-runner.ts';

describe('file mailbox in the README', () => {
  it('names the file mailbox as the tier-three path, and no MCP mailbox, as this build carries none', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8').replace(/\s+/g, ' ');
    expect(readme).not.toMatch(/MCP mailbox/i);
    expect(readme).toMatch(/Tier three is a shared file mailbox/);
    expect(readFileSync(join(repoRoot, 'sagespec.example.yml'), 'utf8')).not.toMatch(/mcp-mailbox/);
  });
});

describe('file mailbox folder', () => {
  it('34: the mailbox folder exists after it is ensured, private to the operator', () => {
    const env = makeTestEnv();
    const path = mailboxPath(defaultTeam(), env);
    expect(path).toBe(join(env.home, '.trellis-crew', 'mailbox'));
    expect(ensureMailboxFolder(path)).toEqual({ ok: true, path, created: true });
    expect(statSync(path).isDirectory()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(ensureMailboxFolder(path)).toEqual({ ok: true, path, created: false });
  });

  it('34: the default is used when the roles file names no mailbox', () => {
    const env = makeTestEnv();
    expect(mailboxPath({}, env)).toBe(join(env.home, DEFAULT_MAILBOX.slice(2)));
  });

  it('34: a relative mailbox resolves against the current folder', () => {
    const env = makeTestEnv();
    expect(mailboxPath({ ...defaultTeam(), mailbox: 'team-mail' }, env)).toBe(join(env.cwd, 'team-mail'));
  });

  it('34: a file in the way is an error, and nothing is created', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'blocked');
    writeFileSync(path, 'not a folder');
    expect(ensureMailboxFolder(path)).toMatchObject({ ok: false });
    const nested = join(env.home, 'blocked', 'inner');
    expect(ensureMailboxFolder(nested)).toMatchObject({ ok: false });
    expect(existsSync(nested)).toBe(false);
  });

  it('34: an existing private folder is kept as it is', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'existing');
    mkdirSync(path, { mode: 0o700 });
    expect(ensureMailboxFolder(path)).toEqual({ ok: true, path, created: false });
    expect(statSync(path).mode & 0o777).toBe(0o700);
  });

  it('an existing folder that other users can open, or a symlink, is refused and left alone', () => {
    const env = makeTestEnv();
    const open = join(env.home, 'open');
    mkdirSync(open);
    chmodSync(open, 0o750);
    expect(ensureMailboxFolder(open)).toMatchObject({ ok: false, message: expect.stringMatching(/open to other users/) });
    expect(statSync(open).mode & 0o777).toBe(0o750);

    const real = join(env.home, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(env.home, 'link');
    symlinkSync(real, link);
    expect(ensureMailboxFolder(link)).toMatchObject({ ok: false, message: expect.stringMatching(/symlink/) });
  });

  it('a folder that another writer swaps in while it is created is checked again, and refused', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'raced');
    const theirs = join(env.home, 'theirs');
    mkdirSync(theirs, { mode: 0o700 });
    // The folder does not exist at the check. Another writer puts a symlink
    // there before mkdir, which then succeeds on the existing path.
    const racingMkdir = (target: string) => {
      symlinkSync(theirs, target);
      mkdirSync(target, { recursive: true, mode: 0o700 });
    };
    expect(ensureMailboxFolder(path, { mkdir: racingMkdir })).toMatchObject({ ok: false, message: expect.stringMatching(/symlink/) });
  });

  it('a parent folder that other users can write, with no sticky bit, is refused', () => {
    const env = makeTestEnv();
    const shared = join(env.home, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const path = join(shared, 'deeper', 'mailbox');
    const result = ensureMailboxFolder(path);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/shared, a parent of .*mailbox, can be written by other users/) });
    expect(existsSync(join(shared, 'deeper'))).toBe(false);

    // An existing private mailbox under that parent is refused too.
    mkdirSync(join(shared, 'kept'), { mode: 0o700 });
    expect(ensureMailboxFolder(join(shared, 'kept'))).toMatchObject({ ok: false, message: expect.stringMatching(/can be written by other users/) });

    // A sticky parent, such as /tmp, is allowed.
    chmodSync(shared, 0o1777);
    expect(ensureMailboxFolder(path)).toMatchObject({ ok: true, created: true });
    chmodSync(shared, 0o700);
  });

  it('a parent folder owned by another user is refused, and root is allowed', () => {
    const env = makeTestEnv();
    const own = process.getuid?.();
    if (own === undefined) return;
    const path = join(env.home, 'mail');
    const other = ensureMailboxFolder(path, { uid: own + 1 });
    expect(other).toMatchObject({ ok: false, message: expect.stringMatching(/a parent of .*mail, belongs to another user/) });
    expect(existsSync(path)).toBe(false);
    // Every ancestor above the fixture home belongs to root or to this user.
    expect(ensureMailboxFolder(path, { uid: own })).toMatchObject({ ok: true, created: true });
  });

  it('a symlink in the path that another user owns is refused, even when its target is private', () => {
    const env = makeTestEnv();
    const own = process.getuid?.();
    if (own === undefined) return;
    const real = join(env.home, 'real');
    mkdirSync(real, { mode: 0o700 });
    const team = join(env.home, 'team');
    symlinkSync(real, team);
    const inner = join(real, 'inner');
    mkdirSync(inner, { mode: 0o700 });
    symlinkSync(inner, join(real, 'hop'));
    const path = join(team, 'hop', 'mail');
    // Owned by this user, each symlink is followed and allowed.
    expect(parentFolderProblem(path, own)).toBeUndefined();
    // Another user owns a symlink: the first one, or one inside its target.
    for (const link of [team, join(real, 'hop')]) {
      const lstat = (target: string) => {
        const stat = lstatSync(target);
        return target === link ? Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as typeof stat, stat, { uid: own + 1 }) : stat;
      };
      expect(parentFolderProblem(path, own, { lstat }), link).toMatch(new RegExp(`^${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, in the path of .*, is a symlink owned by another user`));
      expect(ensureMailboxFolder(path, { uid: own, lstat }), link).toMatchObject({ ok: false });
    }
    expect(existsSync(join(inner, 'mail'))).toBe(false);
    // A symlink owned by root is allowed.
    const rootOwned = (target: string) => {
      const stat = lstatSync(target);
      return target === team ? Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as typeof stat, stat, { uid: 0 }) : stat;
    };
    expect(parentFolderProblem(path, own, { lstat: rootOwned })).toBeUndefined();
  });

  it('a mailbox path with a .. part after a link is refused, and nothing is created', () => {
    const env = makeTestEnv();
    const own = process.getuid?.();
    const target = join(env.home, 'target');
    mkdirSync(join(target, 'inner'), { recursive: true, mode: 0o700 });
    mkdirSync(join(env.home, 's'), { mode: 0o700 });
    const link = join(env.home, 's', 'l');
    symlinkSync(join(target, 'inner'), link);
    const path = `${link}/../mbox/x`;
    const lstat = (p: string) => {
      const stat = lstatSync(p);
      return p === link && own !== undefined ? Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as typeof stat, stat, { uid: own + 1 }) : stat;
    };
    for (const options of [{}, { lstat }]) {
      const result = ensureMailboxFolder(path, options);
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining(`${path} must not hold a .. part`) });
    }
    expect(existsSync(join(target, 'mbox'))).toBe(false);
    expect(existsSync(join(env.home, 's', 'mbox'))).toBe(false);
  });

  it('a folder owned by another user is refused', () => {
    const env = makeTestEnv();
    const path = join(env.home, 'theirs');
    mkdirSync(path, { mode: 0o700 });
    const own = process.getuid?.();
    if (own === undefined) return;
    expect(privateFolderProblem(path, own)).toBeUndefined();
    expect(privateFolderProblem(path, own + 1)).toMatch(/belongs to another user/);
  });

  it('the state folder is checked before install.yml or team.json is written', async () => {
    const env = makeTestEnv();
    const elsewhere = join(env.home, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(env.home, '.trellis-crew'));
    expect(() => writeInstallRecord(env, { harness: 'codex', transport: 'file-mailbox', plugin_version: null })).toThrow(/symlink/);
    expect(() => writeTeam(env, { version: 1, harness: 'codex', sessions: [] })).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);

    // Codex exports its skills into the project first, so the install runs at a git worktree top.
    const err = capture();
    const code = await main(['install', '--harness', 'codex', '--non-interactive'], {
      env: { ...env, cwd: makeFixtureRepo().root },
      runner: gitRunner(),
      out: () => {},
      err: err.write,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/\.trellis-crew is a symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
