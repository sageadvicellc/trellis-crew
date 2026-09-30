import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approvedSkills,
  checkSkills,
  EXCLUDE_BEGIN,
  EXCLUDE_END,
  exportSkills,
  nodeExportFs,
  projectSkillsDir,
  projectTop,
  SKILL_MARKER,
  swapIn,
  treeHash,
  updateExcludeText,
  type ExportContext,
  type ExportFs,
} from '../src/adapters/codex-skills.ts';
import { main } from '../src/cli.ts';
import { makeFixtureHome, makeTestEnv } from './helpers/env.ts';
import { makeFixtureRepo, type FixtureRepo } from './helpers/git-repo.ts';
import { gitRunner } from './helpers/git-runner.ts';
import { repoRoot } from './helpers/paths.ts';
import { installedInRepo } from './helpers/team.ts';

type Tree = Record<string, string>;

/** A stand-in package folder: a plugin manifest that lists `listed`, and a folder for each skill in `skills`. */
function standInPackage(skills: Record<string, Tree>, listed: readonly string[]): string {
  const root = makeFixtureHome();
  mkdirSync(join(root, '.claude-plugin'));
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'trellis-crew', version: '0.1.0', skills: listed.map((name) => `./skills/${name}/`) }),
  );
  for (const [name, files] of Object.entries(skills)) writeTree(join(root, 'skills', name), files);
  return root;
}

function writeTree(dir: string, files: Tree): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** Every entry under `dir`, as relative path and text, for a before-and-after comparison. */
function snapshot(dir: string): Tree {
  const out: Tree = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const abs = join(dir, rel);
    const stat = lstatSync(abs);
    out[rel] = stat.isFile() ? readFileSync(abs, 'utf8') : stat.isSymbolicLink() ? '<link>' : '<dir>';
  }
  return out;
}

function marker(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, SKILL_MARKER), 'utf8'));
}

/** Writes a marker. With no hash given, it holds the folder's own tree hash, as an export would. */
function writeMarker(dir: string, skill: string, options: { owner?: string; sha256?: string } = {}): void {
  const sha256 = options.sha256 ?? treeHash(dir);
  writeFileSync(join(dir, SKILL_MARKER), JSON.stringify({ owner: options.owner ?? 'trellis-crew', skill, sha256 }));
}

function dotEntries(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.'));
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

const TWO = { alpha: { 'SKILL.md': 'alpha v1\n', 'refs/notes.md': 'alpha notes\n' }, beta: { 'SKILL.md': 'beta v1\n' } };

const quietOut = (): void => {};

interface Project {
  repo: FixtureRepo;
  top: string;
  target: string;
  home: string;
  exclude: string;
  ctx: (out?: (line: string) => void) => ExportContext;
}

/** A fresh git repository as the project, with its top as the Env cwd, and a home apart from it. */
function project(repo: FixtureRepo = makeFixtureRepo(), cwd = repo.root): Project {
  const env = makeTestEnv({ cwd });
  const runner = gitRunner();
  return {
    repo,
    top: cwd,
    target: projectSkillsDir(cwd),
    home: env.home,
    exclude: join(repo.root, '.git', 'info', 'exclude'),
    ctx: (out = quietOut) => ({ env, runner, out }),
  };
}

/** An ExportFs over the real file system, with hooks a test sets. */
function hookedFs(hooks: { rename?: (from: string, to: string) => void; remove?: (path: string) => void } = {}): ExportFs {
  return { ...nodeExportFs, ...hooks };
}

/** Wraps an ExportFs and records every path it creates, writes, moves, or removes. */
function recordingFs(base: ExportFs = nodeExportFs): { fs: ExportFs; paths: string[] } {
  const paths: string[] = [];
  const fs: ExportFs = {
    mkdir: (path, m) => {
      paths.push(path);
      base.mkdir(path, m);
    },
    mkdtemp: (prefix) => {
      const path = base.mkdtemp(prefix);
      paths.push(path);
      return path;
    },
    copyFile: (from, to) => {
      paths.push(to);
      base.copyFile(from, to);
    },
    writeFile: (path, text) => {
      paths.push(path);
      base.writeFile(path, text);
    },
    writeAtomic: (path, text, m) => {
      paths.push(path);
      base.writeAtomic(path, text, m);
    },
    chmod: (path, m) => {
      paths.push(path);
      base.chmod(path, m);
    },
    rename: (from, to) => {
      paths.push(from, to);
      base.rename(from, to);
    },
    remove: (path) => {
      paths.push(path);
      base.remove(path);
    },
  };
  return { fs, paths };
}

/** Fails on any recorded path outside `<top>/.agents/skills`, except `<top>/.agents` itself, the one exclude file, and its lock file. */
function expectOnlyProjectWrites(paths: readonly string[], top: string, exclude: string): void {
  const skills = join(top, '.agents', 'skills');
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    const allowed =
      path === join(top, '.agents') || path === skills || path.startsWith(skills + sep) || path === exclude || path === `${exclude}.trellis-crew.lock`;
    expect(allowed, path).toBe(true);
    expect(path.split(sep), path).not.toContain('..');
  }
}

function block(...lines: string[]): string {
  return [EXCLUDE_BEGIN, ...lines, EXCLUDE_END].join('\n') + '\n';
}

describe('approved skills', () => {
  it('reads the skills list from the plugin manifest', () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    expect(approvedSkills(root)).toEqual({
      ok: true,
      skills: [
        { name: 'alpha', source: join(root, 'skills', 'alpha') },
        { name: 'beta', source: join(root, 'skills', 'beta') },
      ],
    });
  });

  it('the real package approves every skill in its manifest', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills: string[] };
    const approved = approvedSkills(repoRoot);
    if (!approved.ok) throw new Error(approved.message);
    expect(approved.skills.map((s) => s.name)).toEqual(manifest.skills.map((entry) => entry.replace(/^\.\/skills\/|\/$/g, '')));
  });

  it('the Codex target is .agents/skills at the project top', () => {
    const top = makeFixtureHome();
    expect(projectSkillsDir(top)).toBe(join(top, '.agents', 'skills'));
  });

  it('a missing or unreadable manifest fails with a named reason', () => {
    expect(approvedSkills(makeFixtureHome())).toMatchObject({ ok: false, message: expect.stringMatching(/plugin manifest .*plugin\.json.* could not be read/) });
    const root = standInPackage(TWO, ['alpha']);
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{ not json');
    expect(approvedSkills(root)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be read/) });
  });

  it('a manifest with no skills list, or an empty one, fails with a named reason', () => {
    const root = standInPackage(TWO, []);
    expect(approvedSkills(root)).toMatchObject({ ok: false, message: expect.stringMatching(/empty skills list/) });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'trellis-crew' }));
    expect(approvedSkills(root)).toMatchObject({ ok: false, message: expect.stringMatching(/has no skills list/) });
  });

  it('a listed skill with no folder, or a link for a folder, fails with a named reason', () => {
    expect(approvedSkills(standInPackage(TWO, ['alpha', 'gamma']))).toMatchObject({ ok: false, message: expect.stringMatching(/approved skill gamma has no folder/) });
    const root = standInPackage({ alpha: TWO.alpha }, ['alpha', 'beta']);
    symlinkSync(makeFixtureHome(), join(root, 'skills', 'beta'));
    expect(approvedSkills(root)).toMatchObject({ ok: false, message: expect.stringMatching(/approved skill beta has no folder/) });
  });

  it('a listed entry outside the skills folder is refused', () => {
    for (const entry of ['../outside/', './skills/../x/', './skills/a/b/', '/skills/alpha/', './skills/.hidden/', 7]) {
      const root = standInPackage(TWO, []);
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: [entry] }));
      const approved = approvedSkills(root);
      expect(!approved.ok && approved.message, String(entry)).toMatch(/not a skill folder under skills\//);
    }
  });

  it('names are deduped case-blind', () => {
    const approved = approvedSkills(standInPackage(TWO, ['alpha', 'Alpha', 'beta', 'ALPHA']));
    expect(approved.ok && approved.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
  });
});

describe('tree hash', () => {
  it('is stable, and the same for a copy with the marker file', () => {
    const a = makeFixtureHome();
    writeTree(a, TWO.alpha);
    const b = makeFixtureHome();
    writeTree(b, TWO.alpha);
    writeMarker(b, 'alpha');
    expect(treeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(treeHash(a)).toBe(treeHash(a));
    expect(treeHash(b)).toBe(treeHash(a));
  });

  it('changes when one byte, a path, a file mode, or an empty folder changes', () => {
    const dir = makeFixtureHome();
    writeTree(dir, TWO.alpha);
    const base = treeHash(dir);
    writeFileSync(join(dir, 'refs', 'notes.md'), 'alpha notez\n');
    expect(treeHash(dir)).not.toBe(base);
    writeFileSync(join(dir, 'refs', 'notes.md'), 'alpha notes\n');
    chmodSync(join(dir, 'SKILL.md'), 0o755);
    expect(treeHash(dir)).not.toBe(base);
    chmodSync(join(dir, 'SKILL.md'), 0o644);
    expect(treeHash(dir)).toBe(base);
    mkdirSync(join(dir, 'empty'));
    expect(treeHash(dir)).not.toBe(base);
    const moved = makeFixtureHome();
    writeTree(moved, { 'SKILL.md': 'alpha v1\n', 'refs/notes2.md': 'alpha notes\n' });
    expect(treeHash(moved)).not.toBe(base);
  });

  it('covers mode & 0o755 only, and keeps file boundaries', () => {
    const dir = makeFixtureHome();
    writeTree(dir, TWO.alpha);
    chmodSync(join(dir, 'SKILL.md'), 0o644);
    const base = treeHash(dir);
    chmodSync(join(dir, 'SKILL.md'), 0o666);
    expect(treeHash(dir)).toBe(base);
    const one = makeFixtureHome();
    writeTree(one, { a: 'xy', b: '' });
    const two = makeFixtureHome();
    writeTree(two, { a: 'x', b: 'y' });
    expect(treeHash(one)).not.toBe(treeHash(two));
  });

  it('refuses a symbolic link in the tree', () => {
    const dir = makeFixtureHome();
    writeTree(dir, TWO.alpha);
    symlinkSync(join(dir, 'SKILL.md'), join(dir, 'link.md'));
    expect(() => treeHash(dir)).toThrow(/symbolic link.*link\.md/);
  });
});

describe('the worktree top', () => {
  it('a valid top passes, after realpath on both sides', async () => {
    const p = project();
    expect(await projectTop(p.ctx().env, p.ctx().runner)).toEqual({ ok: true, top: p.top });
  });

  it('the home folder is refused, even when it is a git worktree top, and git never runs', async () => {
    const repo = makeFixtureRepo();
    const env = makeTestEnv({ home: repo.root, cwd: repo.root });
    const runner = gitRunner();
    expect(await projectTop(env, runner)).toMatchObject({ ok: false, message: expect.stringMatching(/is your home folder/) });
    expect(runner.gitCalls).toEqual([]);
  });

  it('the root folder is refused, and git never runs', async () => {
    const runner = gitRunner();
    expect(await projectTop(makeTestEnv({ cwd: '/' }), runner)).toMatchObject({ ok: false, message: expect.stringMatching(/is the root folder/) });
    expect(runner.gitCalls).toEqual([]);
  });

  it('a folder outside any git repository is refused', async () => {
    const env = makeTestEnv({ cwd: makeFixtureHome() });
    expect(await projectTop(env, gitRunner())).toMatchObject({ ok: false, message: expect.stringMatching(/is not inside a git worktree/) });
  });

  it('a subfolder of a repository is refused, and the export writes nothing', async () => {
    const repo = makeFixtureRepo();
    mkdirSync(join(repo.root, 'sub'));
    const p = project(repo, join(repo.root, 'sub'));
    const top = await projectTop(p.ctx().env, p.ctx().runner);
    expect(top).toMatchObject({ ok: false, message: expect.stringMatching(/is not the top of its git worktree/) });
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toMatch(/the skill export stopped: .*is not the top of its git worktree/);
    expect(existsSync(join(repo.root, '.agents'))).toBe(false);
    expect(existsSync(join(repo.root, 'sub', '.agents'))).toBe(false);
    const check = await checkSkills(p.ctx(), standInPackage(TWO, ['alpha']));
    expect(!check.ok && check.message).toMatch(/is not the top of its git worktree/);
  });
});

describe('skill export', () => {
  it('a fresh copy writes the approved skills and their markers at the project top', async () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const p = project();
    const lines: string[] = [];
    expect(await exportSkills(p.ctx((l) => lines.push(l)), { root })).toEqual({ ok: true });
    expect(readdirSync(p.target).sort()).toEqual(['alpha', 'beta']);
    for (const name of ['alpha', 'beta'] as const) {
      const copy = join(p.target, name);
      const source = join(root, 'skills', name);
      expect(snapshot(copy)).toEqual({ ...snapshot(source), [SKILL_MARKER]: expect.any(String) });
      expect(marker(copy)).toEqual({ owner: 'trellis-crew', skill: name, sha256: treeHash(source) });
    }
    expect(lines.join('\n')).toContain(p.target);
    expect(readdirSync(p.home)).toEqual([]);
  });

  it('applies the source modes with group and other write bits masked', async () => {
    const root = standInPackage(TWO, ['alpha']);
    const source = join(root, 'skills', 'alpha');
    chmodSync(join(source, 'SKILL.md'), 0o775);
    chmodSync(join(source, 'refs', 'notes.md'), 0o666);
    chmodSync(join(source, 'refs'), 0o777);
    chmodSync(source, 0o775);
    const p = project();
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    expect(mode(join(p.target, 'alpha', 'SKILL.md'))).toBe(0o755);
    expect(mode(join(p.target, 'alpha', 'refs', 'notes.md'))).toBe(0o644);
    expect(mode(join(p.target, 'alpha', 'refs'))).toBe(0o755);
    expect(mode(join(p.target, 'alpha'))).toBe(0o755);
    expect(await checkSkills(p.ctx(), root)).toMatchObject({ ok: true, skills: [{ skill: 'alpha', state: 'in-step' }] });
  });

  it('an unlisted package folder is not exported', async () => {
    const root = standInPackage({ ...TWO, private: { 'SKILL.md': 'not approved\n' } }, ['alpha', 'beta']);
    const p = project();
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    expect(readdirSync(p.target).sort()).toEqual(['alpha', 'beta']);
  });

  it('a second install replaces an owned folder and removes a stale owned one, and touches nothing else', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    writeTree(join(p.target, 'users-own'), { 'SKILL.md': 'mine\n' });
    writeTree(join(p.target, '.dot-folder'), { 'x.md': 'mine\n' });
    writeFileSync(join(p.target, 'loose.md'), 'mine\n');
    const own = snapshot(join(p.target, 'users-own'));
    const second = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    const lines: string[] = [];
    expect(await exportSkills(p.ctx((l) => lines.push(l)), { root: second })).toEqual({ ok: true });
    expect(snapshot(join(p.target, 'alpha'))).toEqual({ 'SKILL.md': 'alpha v2\n', [SKILL_MARKER]: expect.any(String) });
    expect(existsSync(join(p.target, 'beta'))).toBe(false);
    expect(lines.join('\n')).toMatch(/Removed the stale skill beta/);
    expect(snapshot(join(p.target, 'users-own'))).toEqual(own);
    expect(readdirSync(p.target).sort()).toEqual(['.dot-folder', 'alpha', 'loose.md', 'users-own']);
  });

  it('a folder whose marker names another skill or owner, or is broken, is never removed as stale', async () => {
    const p = project();
    writeTree(join(p.target, 'gamma'), { 'SKILL.md': 'x\n' });
    writeMarker(join(p.target, 'gamma'), 'other-name');
    writeTree(join(p.target, 'delta'), { 'SKILL.md': 'x\n' });
    writeMarker(join(p.target, 'delta'), 'delta', { owner: 'someone-else' });
    writeTree(join(p.target, 'epsilon'), { 'SKILL.md': 'x\n' });
    writeFileSync(join(p.target, 'epsilon', SKILL_MARKER), '{ broken');
    writeTree(join(p.target, 'zeta'), { 'SKILL.md': 'x\n' });
    writeMarker(join(p.target, 'zeta'), 'zeta', { sha256: 'not-hex' });
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    for (const name of ['gamma', 'delta', 'epsilon', 'zeta']) expect(existsSync(join(p.target, name, 'SKILL.md')), name).toBe(true);
  });

  it('a marker that is a link, a folder, or over 4 KiB does not make a folder owned', async () => {
    const cases: [string, (dir: string) => void][] = [
      [
        'link',
        (dir) => {
          const real = makeFixtureHome();
          writeTree(real, { 'SKILL.md': 'beta v1\n' });
          writeMarker(real, 'beta');
          symlinkSync(join(real, SKILL_MARKER), join(dir, SKILL_MARKER));
        },
      ],
      ['folder', (dir) => mkdirSync(join(dir, SKILL_MARKER))],
      [
        'large',
        (dir) =>
          writeFileSync(join(dir, SKILL_MARKER), JSON.stringify({ owner: 'trellis-crew', skill: 'beta', sha256: treeHash(dir), pad: 'x'.repeat(5000) })),
      ],
    ];
    for (const [label, plant] of cases) {
      const p = project();
      writeTree(join(p.target, 'beta'), { 'SKILL.md': 'mine\n' });
      plant(join(p.target, 'beta'));
      const before = snapshot(p.target);
      const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) });
      expect(!result.ok && result.message, label).toMatch(/beta \(a folder trellis-crew does not own\)/);
      expect(snapshot(p.target), label).toEqual(before);
    }
  });

  it('a user folder with the same name is untouched, fails the export, and nothing is changed', async () => {
    const p = project();
    writeTree(join(p.target, 'beta'), { 'SKILL.md': 'my own beta\n' });
    const before = snapshot(p.top);
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) });
    expect(!result.ok && result.message).toMatch(/skill export stopped.*beta \(a folder trellis-crew does not own\)/);
    expect(!result.ok && result.message).toContain(join(p.target, 'beta'));
    expect(snapshot(p.top)).toEqual(before);
  });

  it('a link in place of a target is refused and left alone', async () => {
    const p = project();
    const elsewhere = makeFixtureHome();
    writeTree(elsewhere, { 'SKILL.md': 'linked\n' });
    writeMarker(elsewhere, 'alpha');
    mkdirSync(p.target, { recursive: true });
    symlinkSync(elsewhere, join(p.target, 'alpha'));
    const before = snapshot(elsewhere);
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) });
    expect(!result.ok && result.message).toMatch(/alpha \(a symbolic link\)/);
    expect(lstatSync(join(p.target, 'alpha')).isSymbolicLink()).toBe(true);
    expect(snapshot(elsewhere)).toEqual(before);
  });

  it('a link in place of .agents/skills or .agents in the project is refused', async () => {
    const root = standInPackage(TWO, ['alpha']);
    const elsewhere = makeFixtureHome();
    const skillsLink = project();
    mkdirSync(dirname(skillsLink.target));
    symlinkSync(elsewhere, skillsLink.target);
    const one = await exportSkills(skillsLink.ctx(), { root });
    expect(!one.ok && one.message).toMatch(/symbolic link/);
    expect(readdirSync(elsewhere)).toEqual([]);

    const agentsLink = project();
    symlinkSync(elsewhere, dirname(agentsLink.target));
    const two = await exportSkills(agentsLink.ctx(), { root });
    expect(!two.ok && two.message).toMatch(/symbolic link/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('a link inside an approved source folder stops the export before anything is written', async () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    symlinkSync(join(root, 'skills', 'alpha', 'SKILL.md'), join(root, 'skills', 'beta', 'link.md'));
    const p = project();
    const result = await exportSkills(p.ctx(), { root });
    expect(!result.ok && result.message).toMatch(/symbolic link/);
    expect(existsSync(p.target)).toBe(false);
  });

  it('a missing manifest or an empty skills list stops the export, and nothing is removed', async () => {
    const p = project();
    const missing = await exportSkills(p.ctx(), { root: makeFixtureHome() });
    expect(!missing.ok && missing.message).toMatch(/plugin manifest/);
    expect(existsSync(p.target)).toBe(false);
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    const before = snapshot(p.top);
    const empty = await exportSkills(p.ctx(), { root: standInPackage(TWO, []) });
    expect(!empty.ok && empty.message).toMatch(/empty skills list/);
    expect(snapshot(p.top)).toEqual(before);
  });

  it('a permission error is a named step, not a thrown error', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha']);
    mkdirSync(p.target, { recursive: true });
    chmodSync(p.target, 0o000);
    try {
      const result = await exportSkills(p.ctx(), { root });
      expect(!result.ok && result.message).toMatch(/skill export stopped.*EACCES/);
      const check = await checkSkills(p.ctx(), root);
      expect(!check.ok && check.message).toMatch(/EACCES/);
    } finally {
      chmodSync(p.target, 0o755);
    }
  });

  it('leaves no temp folder behind', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    await exportSkills(p.ctx(), { root });
    await exportSkills(p.ctx(), { root });
    expect(dotEntries(p.target)).toEqual([]);
    writeTree(join(p.target, 'gamma'), { 'SKILL.md': 'mine\n' });
    const listed = standInPackage({ ...TWO, gamma: { 'SKILL.md': 'g\n' } }, ['alpha', 'beta', 'gamma']);
    expect((await exportSkills(p.ctx(), { root: listed })).ok).toBe(false);
    expect(dotEntries(p.target)).toEqual([]);
  });
});

describe('leftover temp folders', () => {
  it('removes an exact-shape folder only when its marker names trellis-crew and the skill and matches its tree', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha']);
    // Removed: exact shape, and a marker that matches the tree.
    writeTree(join(p.target, '.trellis-crew-alpha-abc123'), { 'SKILL.md': 'staged\n' });
    writeMarker(join(p.target, '.trellis-crew-alpha-abc123'), 'alpha');
    writeTree(join(p.target, '.trellis-crew-alpha-Xy9Q2z-old'), { 'SKILL.md': 'old\n' });
    writeMarker(join(p.target, '.trellis-crew-alpha-Xy9Q2z-old'), 'alpha');
    // Reported and kept: exact shape, but no marker, or a marker that does not match.
    writeTree(join(p.target, '.trellis-crew-alpha-backup'), { 'SKILL.md': 'my backup\n' });
    writeTree(join(p.target, '.trellis-crew-alpha-hash01'), { 'SKILL.md': 'edited\n' });
    writeMarker(join(p.target, '.trellis-crew-alpha-hash01'), 'alpha', { sha256: 'b'.repeat(64) });
    writeTree(join(p.target, '.trellis-crew-alpha-name01'), { 'SKILL.md': 'x\n' });
    writeMarker(join(p.target, '.trellis-crew-alpha-name01'), 'beta');
    writeTree(join(p.target, '.trellis-crew-alpha-zz9999'), { 'SKILL.md': 'theirs\n' });
    writeMarker(join(p.target, '.trellis-crew-alpha-zz9999'), 'alpha', { owner: 'someone-else' });
    // Never read: not the exact shape, or not a real folder.
    writeTree(join(p.target, '.trellis-crew-backup'), { 'x.md': 'mine\n' });
    writeTree(join(p.target, '.trellis-crew-gamma-abc123'), { 'x.md': 'not an approved name\n' });
    writeTree(join(p.target, '.trellis-crew-alpha-abc12'), { 'x.md': 'five characters\n' });
    symlinkSync(makeFixtureHome(), join(p.target, '.trellis-crew-alpha-link01'));
    writeFileSync(join(p.target, '.trellis-crew-note'), 'mine\n');

    const kept = ['.trellis-crew-alpha-backup', '.trellis-crew-alpha-hash01', '.trellis-crew-alpha-name01', '.trellis-crew-alpha-zz9999'];
    const check = await checkSkills(p.ctx(), root);
    expect(check).toMatchObject({
      ok: true,
      leftovers: [join(p.target, '.trellis-crew-alpha-Xy9Q2z-old'), join(p.target, '.trellis-crew-alpha-abc123')],
      strays: kept.map((name) => join(p.target, name)),
    });

    const lines: string[] = [];
    expect(await exportSkills(p.ctx((l) => lines.push(l)), { root })).toEqual({ ok: true });
    expect(dotEntries(p.target).sort()).toEqual(
      [...kept, '.trellis-crew-alpha-abc12', '.trellis-crew-alpha-link01', '.trellis-crew-backup', '.trellis-crew-gamma-abc123', '.trellis-crew-note'].sort(),
    );
    expect(readFileSync(join(p.target, '.trellis-crew-alpha-backup', 'SKILL.md'), 'utf8')).toBe('my backup\n');
    for (const name of kept) expect(lines.join('\n')).toMatch(new RegExp(`warning: .*${name}.*left alone`));
    expect(lines.join('\n')).not.toMatch(/\.trellis-crew-backup/);
  });
});

describe('migrating a copy made before markers', () => {
  it('an exact unmarked copy is adopted: it gets a marker and counts as owned', async () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const p = project();
    mkdirSync(p.target, { recursive: true });
    cpSync(join(root, 'skills', 'alpha'), join(p.target, 'alpha'), { recursive: true });
    const lines: string[] = [];
    expect(await exportSkills(p.ctx((l) => lines.push(l)), { root })).toEqual({ ok: true });
    expect(marker(join(p.target, 'alpha'))).toEqual({ owner: 'trellis-crew', skill: 'alpha', sha256: treeHash(join(root, 'skills', 'alpha')) });
    expect(lines.join('\n')).toMatch(/Adopted the unmarked copy of alpha/);
    expect(await checkSkills(p.ctx(), root)).toMatchObject({ ok: true, skills: [{ state: 'in-step' }, { state: 'in-step' }] });
  });

  it('a modified unmarked copy stops the install and is untouched', async () => {
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const p = project();
    mkdirSync(p.target, { recursive: true });
    cpSync(join(root, 'skills', 'alpha'), join(p.target, 'alpha'), { recursive: true });
    writeFileSync(join(p.target, 'alpha', 'SKILL.md'), 'alpha v1, edited\n');
    const before = snapshot(p.target);
    const result = await exportSkills(p.ctx(), { root });
    expect(!result.ok && result.message).toMatch(/alpha \(a folder trellis-crew does not own\)/);
    expect(snapshot(p.target)).toEqual(before);
  });

  it('an exact unmarked copy of an unlisted package folder is removed as stale; a changed one stays', async () => {
    const root = standInPackage({ ...TWO, retired: { 'SKILL.md': 'retired\n' }, kept: { 'SKILL.md': 'kept\n' } }, ['alpha']);
    const p = project();
    mkdirSync(p.target, { recursive: true });
    cpSync(join(root, 'skills', 'retired'), join(p.target, 'retired'), { recursive: true });
    cpSync(join(root, 'skills', 'kept'), join(p.target, 'kept'), { recursive: true });
    writeFileSync(join(p.target, 'kept', 'SKILL.md'), 'kept, edited\n');
    expect(await checkSkills(p.ctx(), root)).toMatchObject({
      ok: true,
      skills: [
        { skill: 'alpha', state: 'missing' },
        { skill: 'retired', state: 'stale' },
      ],
    });
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    expect(existsSync(join(p.target, 'retired'))).toBe(false);
    expect(readFileSync(join(p.target, 'kept', 'SKILL.md'), 'utf8')).toBe('kept, edited\n');
  });
});

describe('the marker hash', () => {
  it('a forged marker with a wrong hash stays untouched and stops the install', async () => {
    const p = project();
    writeTree(join(p.target, 'alpha'), { 'SKILL.md': 'my alpha\n' });
    writeMarker(join(p.target, 'alpha'), 'alpha', { sha256: 'a'.repeat(64) });
    const before = snapshot(p.target);
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toMatch(/alpha \(a trellis-crew copy edited since export\)/);
    expect(snapshot(p.target)).toEqual(before);
  });

  it('an owned copy edited after the export is untouched and stops the install', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    writeFileSync(join(p.target, 'alpha', 'SKILL.md'), 'my change\n');
    const before = snapshot(p.target);
    const result = await exportSkills(p.ctx(), { root });
    expect(!result.ok && result.message).toMatch(/alpha \(a trellis-crew copy edited since export\)/);
    expect(snapshot(p.target)).toEqual(before);
  });

  it('an edited owned folder whose skill is no longer approved is not removed, and stops the install', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    writeFileSync(join(p.target, 'beta', 'SKILL.md'), 'my change\n');
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toMatch(/beta \(a trellis-crew copy edited since export\)/);
    expect(readFileSync(join(p.target, 'beta', 'SKILL.md'), 'utf8')).toBe('my change\n');
  });

  it('a valid owned copy from an older package is replaced', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    const newer = standInPackage({ alpha: { 'SKILL.md': 'alpha v3\n' } }, ['alpha']);
    expect(await checkSkills(p.ctx(), newer)).toMatchObject({ ok: true, skills: [{ skill: 'alpha', state: 'drifted' }] });
    expect(await exportSkills(p.ctx(), { root: newer })).toEqual({ ok: true });
    expect(snapshot(join(p.target, 'alpha'))).toEqual({ 'SKILL.md': 'alpha v3\n', [SKILL_MARKER]: expect.any(String) });
  });
});

describe('the swap', () => {
  async function ownedPair(): Promise<{ dest: string; temp: string }> {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    const temp = join(p.target, '.trellis-crew-alpha-test01');
    writeTree(temp, { 'SKILL.md': 'alpha new\n' });
    writeMarker(temp, 'alpha');
    return { dest: join(p.target, 'alpha'), temp };
  }

  it('a failed swap puts the old copy back', async () => {
    const { dest, temp } = await ownedPair();
    const before = snapshot(dest);
    const fsx = hookedFs({
      rename: (from, to) => {
        if (from === temp) throw new Error('swap refused');
        renameSync(from, to);
      },
    });
    expect(() => swapIn(temp, dest, 'alpha', 'replace', fsx, quietOut)).toThrow(/^swap refused$/);
    expect(snapshot(dest)).toEqual(before);
    expect(existsSync(`${temp}-old`)).toBe(false);
  });

  it('a failed rollback names both errors and the -old path, and keeps the cause', async () => {
    const { dest, temp } = await ownedPair();
    const swapError = new Error('swap refused');
    const fsx = hookedFs({
      rename: (from, to) => {
        if (from === temp) throw swapError;
        if (from.endsWith('-old')) throw new Error('rollback refused');
        renameSync(from, to);
      },
    });
    let caught: unknown;
    try {
      swapIn(temp, dest, 'alpha', 'replace', fsx, quietOut);
    } catch (error) {
      caught = error;
    }
    const error = caught as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('swap refused');
    expect(error.message).toContain('rollback refused');
    expect(error.message).toContain(`${temp}-old`);
    expect(error.cause).toBe(swapError);
  });

  it('a folder edited in the gap after the rename is put back, and nothing is removed', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    const newer = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    const fsx = hookedFs({
      rename: (from, to) => {
        renameSync(from, to);
        if (to.endsWith('-old')) writeFileSync(join(to, 'SKILL.md'), 'edited in the gap\n');
      },
    });
    const result = await exportSkills(p.ctx(), { root: newer, fs: fsx });
    expect(!result.ok && result.message).toMatch(/changed during the export, so it was put back and nothing was removed/);
    expect(readFileSync(join(p.target, 'alpha', 'SKILL.md'), 'utf8')).toBe('edited in the gap\n');
    expect(existsSync(join(p.target, 'beta'))).toBe(true);
    expect(dotEntries(p.target)).toEqual([]);
  });

  it('when the old copy cannot be removed, the new copy counts as installed and a warning names the leftover', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha']);
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    const newer = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    const lines: string[] = [];
    const fsx = hookedFs({
      remove: (path) => {
        if (path.endsWith('-old')) throw new Error('remove refused');
        rmSync(path, { recursive: true, force: true });
      },
    });
    expect(await exportSkills(p.ctx((l) => lines.push(l)), { root: newer, fs: fsx })).toEqual({ ok: true });
    expect(readFileSync(join(p.target, 'alpha', 'SKILL.md'), 'utf8')).toBe('alpha v2\n');
    const leftover = dotEntries(p.target);
    expect(leftover).toHaveLength(1);
    expect(lines.join('\n')).toMatch(new RegExp(`warning: .*${leftover[0]}.*remove refused`));
    expect(await checkSkills(p.ctx(), newer)).toMatchObject({ ok: true, leftovers: [join(p.target, leftover[0] as string)] });
  });

  it('a failure partway through names the skills already copied and says to run update again', async () => {
    const p = project();
    const fsx = hookedFs({
      rename: (from, to) => {
        if (to === join(p.target, 'beta')) throw new Error('disk full');
        renameSync(from, to);
      },
    });
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']), fs: fsx });
    expect(!result.ok && result.message).toMatch(/disk full.*Already copied: alpha\..*Run trellis-crew update again to finish/);
    expect(existsSync(join(p.target, 'alpha', SKILL_MARKER))).toBe(true);
    expect(existsSync(join(p.target, 'beta'))).toBe(false);
    expect(dotEntries(p.target)).toEqual([]);
  });
});

describe('no write outside the project', () => {
  it('a fresh export writes only under .agents/skills, plus the exclude file', async () => {
    const p = project();
    const { fs, paths } = recordingFs();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']), fs })).toEqual({ ok: true });
    expectOnlyProjectWrites(paths, p.top, p.exclude);
    expect(paths).toContain(p.exclude);
    expect(readdirSync(p.home)).toEqual([]);
  });

  it('a replace and a stale removal write only under .agents/skills, plus the exclude file', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    const { fs, paths } = recordingFs();
    const newer = standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']);
    expect(await exportSkills(p.ctx(), { root: newer, fs })).toEqual({ ok: true });
    expect(paths).toContain(join(p.target, 'beta'));
    expect(paths.some((path) => path.endsWith('-old'))).toBe(true);
    expectOnlyProjectWrites(paths, p.top, p.exclude);
    expect(readdirSync(p.home)).toEqual([]);
  });

  it('a rollback writes only under .agents/skills', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    const failing = hookedFs({
      rename: (from, to) => {
        if (to === join(p.target, 'alpha') && !from.endsWith('-old')) throw new Error('swap refused');
        renameSync(from, to);
      },
    });
    const { fs, paths } = recordingFs(failing);
    const result = await exportSkills(p.ctx(), { root: standInPackage({ alpha: { 'SKILL.md': 'alpha v2\n' } }, ['alpha']), fs });
    expect(!result.ok && result.message).toMatch(/swap refused/);
    expect(paths.some((path) => path.endsWith('-old'))).toBe(true);
    expectOnlyProjectWrites(paths, p.top, p.exclude);
  });

  it('a linked worktree writes under its own top, plus the common exclude file', async () => {
    const repo = makeFixtureRepo();
    repo.write('README.md', 'x\n');
    repo.commit('init');
    const wt = join(makeFixtureHome(), 'wt');
    repo.git('worktree', 'add', '-q', wt);
    const p = project(repo, wt);
    const { fs, paths } = recordingFs();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']), fs })).toEqual({ ok: true });
    expect(p.exclude).toBe(join(repo.root, '.git', 'info', 'exclude'));
    expectOnlyProjectWrites(paths, wt, p.exclude);
    expect(readFileSync(p.exclude, 'utf8')).toContain('/.agents/skills/alpha/');
    expect(existsSync(join(wt, '.agents', 'skills', 'alpha', SKILL_MARKER))).toBe(true);
    expect(existsSync(join(repo.root, '.agents'))).toBe(false);
    expect(repo.git('-C', wt, 'status', '--porcelain')).toBe('');
  });
});

describe('git state', () => {
  it('the first export creates the managed block, and git status stays clean', async () => {
    const p = project();
    const before = readFileSync(p.exclude, 'utf8');
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['beta', 'alpha']) })).toEqual({ ok: true });
    expect(readFileSync(p.exclude, 'utf8')).toBe(block('/.agents/skills/alpha/', '/.agents/skills/beta/') + before);
    expect(p.repo.git('status', '--porcelain')).toBe('');
  });

  it('a second export adds nothing new', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    const once = readFileSync(p.exclude, 'utf8');
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    expect(readFileSync(p.exclude, 'utf8')).toBe(once);
  });

  it('a stale removal takes out only its own line', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    const user = readFileSync(p.exclude, 'utf8').split(EXCLUDE_END + '\n')[1] as string;
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    expect(readFileSync(p.exclude, 'utf8')).toBe(block('/.agents/skills/alpha/') + user);
  });

  it('user lines above, below, and inside the block survive, and an inside one is warned about', async () => {
    const p = project();
    writeFileSync(p.exclude, `# mine above\n${EXCLUDE_BEGIN}\n/custom/\n/.agents/skills/alpha/\n${EXCLUDE_END}\n# mine below`);
    const lines: string[] = [];
    expect(await exportSkills(p.ctx((l) => lines.push(l)), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    expect(readFileSync(p.exclude, 'utf8')).toBe(
      `# mine above\n${EXCLUDE_BEGIN}\n/custom/\n/.agents/skills/alpha/\n/.agents/skills/beta/\n${EXCLUDE_END}\n# mine below`,
    );
    expect(lines.join('\n')).toMatch(/warning: .*\/custom\//);
  });

  it('an empty block after a stale removal is removed whole, and a missing trailing newline is kept', () => {
    const user = '# mine\n*.log';
    const withBlock = updateExcludeText(user, { add: ['alpha'], remove: [], known: ['alpha'] });
    if (!withBlock.ok) throw new Error(withBlock.message);
    expect(withBlock.text).toBe(block('/.agents/skills/alpha/') + user);
    const without = updateExcludeText(withBlock.text, { add: [], remove: ['alpha'], known: ['alpha'] });
    expect(without).toMatchObject({ ok: true, text: user });
    const kept = updateExcludeText(`${user}\n${block('/mine/', '/.agents/skills/alpha/')}`, { add: [], remove: ['alpha'], known: ['alpha'] });
    expect(kept).toMatchObject({ ok: true, text: `${user}\n${block('/mine/')}`, warnings: [expect.stringContaining('/mine/')] });
    const unknown = updateExcludeText(block('/.agents/skills/theirs/'), { add: [], remove: ['alpha'], known: ['alpha'] });
    expect(unknown).toMatchObject({ ok: true, text: block('/.agents/skills/theirs/') });
  });

  it('a broken block is refused, and the file and the skills are unchanged', async () => {
    for (const text of [`${EXCLUDE_BEGIN}\n/.agents/skills/alpha/\n`, block('/a/') + block('/b/'), `${EXCLUDE_END}\n${EXCLUDE_BEGIN}\n`]) {
      const p = project();
      writeFileSync(p.exclude, text);
      const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) });
      expect(!result.ok && result.message, text).toMatch(/the skill export stopped: .*exclude.*(no end line|two|out of order)/);
      expect(readFileSync(p.exclude, 'utf8')).toBe(text);
      expect(existsSync(p.target)).toBe(false);
    }
  });

  it('a link at .git/info or at the exclude file is refused', async () => {
    const infoLink = project();
    const moved = join(makeFixtureHome(), 'info');
    renameSync(dirname(infoLink.exclude), moved);
    symlinkSync(moved, dirname(infoLink.exclude));
    const one = await exportSkills(infoLink.ctx(), { root: standInPackage(TWO, ['alpha']) });
    expect(!one.ok && one.message).toMatch(/info is a symbolic link/);
    expect(existsSync(infoLink.target)).toBe(false);

    const fileLink = project();
    const real = join(makeFixtureHome(), 'exclude');
    writeFileSync(real, '# elsewhere\n');
    rmSync(fileLink.exclude);
    symlinkSync(real, fileLink.exclude);
    const two = await exportSkills(fileLink.ctx(), { root: standInPackage(TWO, ['alpha']) });
    expect(!two.ok && two.message).toMatch(/exclude is a symbolic link/);
    expect(readFileSync(real, 'utf8')).toBe('# elsewhere\n');
  });

  it('the exclude file is created when missing, with mode 0644, and an existing mode is kept', async () => {
    const p = project();
    rmSync(p.exclude);
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    expect(readFileSync(p.exclude, 'utf8')).toBe(block('/.agents/skills/alpha/'));
    expect(mode(p.exclude)).toBe(0o644);

    const q = project();
    chmodSync(q.exclude, 0o600);
    expect(await exportSkills(q.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    expect(mode(q.exclude)).toBe(0o600);
  });

  it('a tracked skill folder stops the install, stays untouched, and nothing changes', async () => {
    const p = project();
    p.repo.write('.agents/skills/alpha/SKILL.md', 'committed\n');
    p.repo.commit('track a skill');
    const before = snapshot(p.target);
    const exclude = readFileSync(p.exclude, 'utf8');
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const result = await exportSkills(p.ctx(), { root });
    expect(!result.ok && result.message).toMatch(/alpha \(tracked in git\)/);
    expect(snapshot(p.target)).toEqual(before);
    expect(readFileSync(p.exclude, 'utf8')).toBe(exclude);
    const check = await checkSkills(p.ctx(), root);
    expect(check.ok && check.skills[0]).toMatchObject({ skill: 'alpha', state: 'not-owned', detail: 'tracked in git' });
  });
});

describe('drift check', () => {
  it('reports each state, and changes nothing', async () => {
    const p = project();
    const skills = {
      steady: { 'SKILL.md': 's\n' },
      drift: { 'SKILL.md': 'd\n' },
      gone: { 'SKILL.md': 'g\n' },
      mine: { 'SKILL.md': 'm\n' },
      linked: { 'SKILL.md': 'l\n' },
      edited: { 'SKILL.md': 'e\n' },
      broken: { 'SKILL.md': 'b\n' },
      bare: { 'SKILL.md': 'u\n' },
      old: { 'SKILL.md': 'o\n' },
    };
    const before = standInPackage(skills, ['steady', 'drift', 'gone', 'edited', 'broken', 'old']);
    expect(await exportSkills(p.ctx(), { root: before })).toEqual({ ok: true });
    writeFileSync(join(p.target, 'drift', 'SKILL.md'), 'D\n');
    writeMarker(join(p.target, 'drift'), 'drift');
    rmSync(join(p.target, 'gone'), { recursive: true });
    writeTree(join(p.target, 'mine'), { 'SKILL.md': 'my own\n' });
    symlinkSync(makeFixtureHome(), join(p.target, 'linked'));
    writeFileSync(join(p.target, 'edited', 'SKILL.md'), 'E\n');
    symlinkSync(join(p.target, 'broken', 'SKILL.md'), join(p.target, 'broken', 'link.md'));
    writeTree(join(p.target, 'bare'), skills.bare);
    const listing = snapshot(p.top);

    const now = standInPackage(skills, ['steady', 'drift', 'gone', 'mine', 'linked', 'edited', 'broken', 'bare']);
    const check = await checkSkills(p.ctx(), now);
    if (!check.ok) throw new Error(check.message);
    expect(check.skills.map((s) => [s.skill, s.state])).toEqual([
      ['steady', 'in-step'],
      ['drift', 'drifted'],
      ['gone', 'missing'],
      ['mine', 'not-owned'],
      ['linked', 'not-owned'],
      ['edited', 'edited'],
      ['broken', 'unreadable'],
      ['bare', 'unmarked'],
      ['old', 'stale'],
    ]);
    expect(check.skills.find((s) => s.skill === 'linked')?.detail).toBe('a symbolic link');
    expect(check.skills.find((s) => s.skill === 'mine')?.detail).toBe('a folder trellis-crew does not own');
    expect(check.skills.find((s) => s.skill === 'broken')?.detail).toMatch(/symbolic link/);
    for (const s of check.skills) expect(s.path).toBe(join(p.target, s.skill));
    expect(snapshot(p.top)).toEqual(listing);
  });

  it('an unreadable marker is its own state, with the error code', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha']);
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    chmodSync(join(p.target, 'alpha'), 0o000);
    try {
      expect(await checkSkills(p.ctx(), root)).toMatchObject({
        ok: true,
        skills: [{ skill: 'alpha', state: 'unreadable', detail: 'marker unreadable (EACCES)' }],
      });
      const result = await exportSkills(p.ctx(), { root });
      expect(!result.ok && result.message).toMatch(/alpha \(unreadable: marker unreadable \(EACCES\)\)/);
    } finally {
      chmodSync(join(p.target, 'alpha'), 0o755);
    }
  });

  it('with no skills folder, every approved skill is missing', async () => {
    const p = project();
    const check = await checkSkills(p.ctx(), standInPackage(TWO, ['alpha', 'beta']));
    expect(check.ok && check.skills.map((s) => s.state)).toEqual(['missing', 'missing']);
  });

  it('a link in place of the skills folder fails the check', async () => {
    const p = project();
    mkdirSync(dirname(p.target));
    symlinkSync(makeFixtureHome(), p.target);
    const check = await checkSkills(p.ctx(), standInPackage(TWO, ['alpha']));
    expect(!check.ok && check.message).toMatch(/symbolic link/);
  });
});

describe('update --check on Codex CLI', () => {
  const quiet = { fetchLatest: async () => ({ status: 'not-published' as const }) };
  const installed = () => installedInRepo('codex', 'file-mailbox', quiet);

  it('all in step: exits 0, prints one line per approved skill after the version lines', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    t.out.lines.length = 0;
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    const approved = approvedSkills(repoRoot);
    if (!approved.ok) throw new Error(approved.message);
    const text = t.out.text();
    for (const { name } of approved.skills) expect(text).toContain(`Skill ${name}: in step.`);
    expect(text.indexOf('trellis-crew CLI:')).toBeLessThan(text.indexOf('Skill '));
    expect(text.indexOf('Plugin:')).toBeLessThan(text.indexOf('Skill '));
    expect(t.err.text()).toBe('');
  });

  it('exits 1 on drift, missing, or stale, names each one, and changes nothing', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = projectSkillsDir(t.repo.root);
    writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'from an older package\n');
    writeMarker(join(target, 'department-lead'), 'department-lead');
    rmSync(join(target, 'department-auditor'), { recursive: true });
    writeTree(join(target, 'retired-skill'), { 'SKILL.md': 'old\n' });
    writeMarker(join(target, 'retired-skill'), 'retired-skill');
    const before = snapshot(t.repo.root);
    const home = snapshot(t.env.home);
    expect(await main(['update', '--check'], t.deps)).toBe(1);
    expect(t.out.text()).toContain('Skill department-lead: drifted.');
    expect(t.out.text()).toContain('Skill department-auditor: missing.');
    expect(t.out.text()).toContain('Skill retired-skill: stale.');
    expect(t.err.text()).toMatch(/department-lead drifted/);
    expect(t.err.text()).toMatch(/department-auditor missing/);
    expect(t.err.text()).toMatch(/retired-skill stale/);
    expect(snapshot(t.repo.root)).toEqual(before);
    expect(snapshot(t.env.home)).toEqual(home);
  });

  const breakers: [string, string, (target: string) => void][] = [
    [
      'drifted',
      'drifted.',
      (target) => {
        writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'x');
        writeMarker(join(target, 'department-lead'), 'department-lead');
      },
    ],
    ['missing', 'missing.', (target) => rmSync(join(target, 'department-lead'), { recursive: true })],
    [
      'stale',
      'stale.',
      (target) => {
        writeTree(join(target, 'retired-skill'), { 'SKILL.md': 'old\n' });
        writeMarker(join(target, 'retired-skill'), 'retired-skill');
      },
    ],
    [
      'not owned',
      'not owned.',
      (target) => {
        rmSync(join(target, 'department-lead'), { recursive: true });
        writeTree(join(target, 'department-lead'), { 'SKILL.md': 'my own\n' });
      },
    ],
    [
      'a link',
      'not owned. ',
      (target) => {
        rmSync(join(target, 'department-lead'), { recursive: true });
        symlinkSync(makeFixtureHome(), join(target, 'department-lead'));
      },
    ],
    ['edited', 'edited since export.', (target) => writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'mine\n')],
    ['unreadable', 'unreadable.', (target) => symlinkSync(join(target, 'department-lead', 'SKILL.md'), join(target, 'department-lead', 'link.md'))],
  ];
  for (const [label, line, breakIt] of breakers) {
    it(`exits 1 on ${label} alone, and names it`, async () => {
      const t = installed();
      expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
      breakIt(projectSkillsDir(t.repo.root));
      expect(await main(['update', '--check'], t.deps)).toBe(1);
      const skill = label === 'stale' ? 'retired-skill' : 'department-lead';
      expect(t.out.text()).toContain(`Skill ${skill}: ${line}`);
      expect(t.err.text()).toContain(skill);
    });
  }

  it('a link gets the same label in install and in the check', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = projectSkillsDir(t.repo.root);
    rmSync(join(target, 'department-lead'), { recursive: true });
    symlinkSync(makeFixtureHome(), join(target, 'department-lead'));
    await main(['update', '--check'], t.deps);
    expect(t.out.text()).toContain(`${join(target, 'department-lead')} is a symbolic link`);
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toContain('department-lead (a symbolic link)');
  });

  it('warns about leftover temp folders by name, with no change in exit code', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = projectSkillsDir(t.repo.root);
    const leftover = join(target, '.trellis-crew-department-lead-abc123');
    writeTree(leftover, { 'SKILL.md': 'staged\n' });
    writeMarker(leftover, 'department-lead');
    const stray = join(target, '.trellis-crew-department-lead-zz9999');
    writeTree(stray, { 'SKILL.md': 'theirs\n' });
    writeMarker(stray, 'department-lead', { owner: 'someone-else' });
    const backup = join(target, '.trellis-crew-department-lead-backup');
    writeTree(backup, { 'SKILL.md': 'my backup\n' });
    writeTree(join(target, '.trellis-crew-backup'), { 'x.md': 'mine\n' });
    expect(await main(['update', '--check'], t.deps)).toBe(0);
    expect(t.err.text()).toMatch(new RegExp(`warning: .*${basename(leftover)}.*next install or update removes it`));
    expect(t.err.text()).toMatch(new RegExp(`warning: .*${basename(stray)}.*left alone`));
    expect(t.err.text()).toMatch(new RegExp(`warning: .*${basename(backup)}.*left alone`));
    expect(t.err.text()).not.toContain('.trellis-crew-backup');
    expect(existsSync(leftover)).toBe(true);
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(stray)).toBe(true);
    expect(existsSync(backup)).toBe(true);
  });

  it('refuses in a subfolder of the project with a named step', async () => {
    const t = installed();
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    mkdirSync(join(t.repo.root, 'sub'));
    const deps = { ...t.deps, env: { ...t.env, cwd: join(t.repo.root, 'sub') } };
    expect(await main(['update', '--check'], deps)).toBe(1);
    expect(t.err.text()).toMatch(/The skill check failed: .*is not the top of its git worktree/);
  });
});

describe('install and update on Codex CLI', () => {
  it('a user folder with a skill name fails the install with a named step and stays untouched', async () => {
    const t = installedInRepo('codex', 'file-mailbox');
    const target = projectSkillsDir(t.repo.root);
    writeTree(join(target, 'department-lead'), { 'SKILL.md': 'my own\n' });
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/The plugin install failed: the skill export stopped.*department-lead/);
    expect(snapshot(join(target, 'department-lead'))).toEqual({ 'SKILL.md': 'my own\n' });
  });

  it('update (not --check) fails cleanly on a conflict: exit 1, a named step, nothing changed', async () => {
    const t = installedInRepo('codex', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const target = projectSkillsDir(t.repo.root);
    writeFileSync(join(target, 'department-lead', 'SKILL.md'), 'my edit\n');
    const before = snapshot(target);
    expect(await main(['update'], t.deps)).toBe(1);
    expect(t.err.text()).toMatch(/The plugin update failed: the skill export stopped: .*department-lead \(a trellis-crew copy edited since export\)/);
    expect(snapshot(target)).toEqual(before);
  });

  it('install run in the home folder is refused, and nothing is written under ~/.agents', async () => {
    const t = installedInRepo('codex', 'file-mailbox');
    const deps = { ...t.deps, env: { ...t.env, cwd: t.env.home } };
    expect(await main(['install', '--harness', 'codex'], deps)).toBe(1);
    expect(t.err.text()).toMatch(/The plugin install failed: the skill export stopped: .*is your home folder/);
    expect(existsSync(join(t.env.home, '.agents'))).toBe(false);
  });

  it('writes the skills at the project top, and never under the home folder', async () => {
    const t = installedInRepo('codex', 'file-mailbox');
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const approved = approvedSkills(repoRoot);
    if (!approved.ok) throw new Error(approved.message);
    expect(readdirSync(projectSkillsDir(t.repo.root)).sort()).toEqual(approved.skills.map((s) => s.name).sort());
    expect(existsSync(join(t.env.home, '.agents'))).toBe(false);
    expect(t.repo.git('status', '--porcelain')).toBe('');
  });
});

/**
 * Finds each line in `text` that sets CODEX_HOME: an assignment, or a key
 * in an object literal. This is a heuristic line scan, not a parser. It
 * catches the common forms; a computed key or a value built at run time
 * could pass it, so review still owns that case.
 */
function codexHomeWrites(text: string): string[] {
  const patterns = [
    /\bCODEX_HOME\s*=(?!=)/,
    /\[\s*['"`]CODEX_HOME['"`]\s*\]\s*=(?!=)/,
    /(?:^|[{,\s])['"`]?CODEX_HOME['"`]?\s*:/,
    /\bCODEX_HOME\s*,?\s*(?:\.\.\.|})/,
  ];
  return text.split('\n').filter((line) => patterns.some((p) => p.test(line)));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => join(dir, rel))
    .filter((abs) => lstatSync(abs).isFile());
}

/** A folder standing in for a home folder that a racer points `.agents` at. It holds `skills/`, so a write that follows the link would land. */
function fakeHome(): string {
  const dir = makeFixtureHome();
  mkdirSync(join(dir, 'skills'));
  return dir;
}

describe('a folder swapped for a link during the export', () => {
  it('.agents created as a link after the survey stops the export before any write lands outside the top', async () => {
    const p = project();
    const racer = fakeHome();
    const hooked: ExportFs = {
      ...nodeExportFs,
      mkdir: (path, m) => {
        // Another process wins the race and makes .agents a link to "home".
        if (path === join(p.top, '.agents')) symlinkSync(racer, path);
        else nodeExportFs.mkdir(path, m);
      },
    };
    const { fs, paths } = recordingFs(hooked);
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']), fs });
    expect(!result.ok && result.message).toMatch(/\.agents is a symbolic link/);
    expect(readdirSync(join(racer, 'skills'))).toEqual([]);
    expect(readdirSync(racer)).toEqual(['skills']);
    expect(paths.filter((path) => path !== join(p.top, '.agents'))).toEqual([]);
  });

  it('.agents swapped for a link between two skills stops the export before the second skill lands outside the top', async () => {
    const p = project();
    const racer = fakeHome();
    const hooked: ExportFs = {
      ...nodeExportFs,
      rename: (from, to) => {
        nodeExportFs.rename(from, to);
        if (to === join(p.target, 'alpha')) {
          // After the first skill is in place, a racer moves .agents away and links it to "home".
          renameSync(join(p.top, '.agents'), join(p.top, 'agents-moved'));
          symlinkSync(racer, join(p.top, '.agents'));
        }
      },
    };
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']), fs: hooked });
    expect(!result.ok && result.message).toMatch(/\.agents changed during the export/);
    expect(!result.ok && result.message).toMatch(/Already copied: alpha/);
    expect(readdirSync(join(racer, 'skills'))).toEqual([]);
    expect(readdirSync(racer)).toEqual(['skills']);
  });

  it('.agents/skills swapped for another real folder is caught by its device and inode', async () => {
    const p = project();
    const hooked: ExportFs = {
      ...nodeExportFs,
      rename: (from, to) => {
        nodeExportFs.rename(from, to);
        if (to === join(p.target, 'alpha')) {
          renameSync(p.target, join(p.top, 'skills-moved'));
          mkdirSync(p.target);
        }
      },
    };
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']), fs: hooked });
    expect(!result.ok && result.message).toMatch(/\.agents\/skills changed during the export/);
    expect(readdirSync(p.target)).toEqual([]);
  });
});

describe('.git/info swapped for a link during the export', () => {
  it('after the survey and before the lock, the run refuses with a named step and writes nothing in either place', async () => {
    const p = project();
    const info = dirname(p.exclude);
    const realInfo = join(makeFixtureHome(), 'info-moved');
    const outside = makeFixtureHome();
    writeFileSync(join(outside, 'exclude'), '# outside\n');
    const before = readFileSync(p.exclude, 'utf8');
    const hooked: ExportFs = {
      ...nodeExportFs,
      mkdir: (path, m) => {
        nodeExportFs.mkdir(path, m);
        if (path === join(p.top, '.agents')) {
          // A racer moves .git/info away and links it to a folder outside the repo.
          renameSync(info, realInfo);
          symlinkSync(outside, info);
        }
      },
    };
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']), fs: hooked });
    expect(!result.ok && result.message).toMatch(/the skill export stopped: .*\.git\/info is a symbolic link/);
    expect(snapshot(outside)).toEqual({ exclude: '# outside\n' });
    expect(readFileSync(join(realInfo, 'exclude'), 'utf8')).toBe(before);
    expect(existsSync(join(realInfo, 'exclude.trellis-crew.lock'))).toBe(false);
    expect(existsSync(join(p.target, 'alpha'))).toBe(false);
  });

  it('a normal run passes with the .git/info pin, and a missing .git/info is made and pinned', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    expect(readFileSync(p.exclude, 'utf8')).toContain('/.agents/skills/alpha/');
    const q = project();
    rmSync(dirname(q.exclude), { recursive: true });
    expect(await exportSkills(q.ctx(), { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    expect(readFileSync(q.exclude, 'utf8')).toBe(block('/.agents/skills/alpha/'));
  });
});

describe('the shared git environment helper', () => {
  it('comes from codex-guard.ts, and codex-skills.ts keeps no copy of its own', async () => {
    const guard = (await import('../src/adapters/codex-guard.ts')) as Record<string, unknown>;
    const skills = (await import('../src/adapters/codex-skills.ts')) as Record<string, unknown>;
    expect(typeof guard.withoutGitVars).toBe('function');
    const strip = guard.withoutGitVars as (vars: Record<string, string | undefined>) => Record<string, string>;
    expect(strip({ GIT_DIR: '/x', GIT_WORK_TREE: '/y', HOME: '/h', PATH: '/p', UNSET: undefined })).toEqual({ HOME: '/h', PATH: '/p' });
    expect('withoutGitVars' in skills).toBe(false);
    const source = readFileSync(join(repoRoot, 'src', 'adapters', 'codex-skills.ts'), 'utf8');
    expect(source).toMatch(/import \{[^}]*\bwithoutGitVars\b[^}]*\} from '\.\/codex-guard\.ts'/);
    expect(source).not.toMatch(/function withoutGitVars/);
    expect(source).not.toMatch(/once that lands|mirrors `withoutGitVars`/);
  });
});

describe('git variables in the parent environment', () => {
  it('are removed, so the top check, the tracked check, and the exclude path see the real repository', async () => {
    const other = makeFixtureRepo();
    other.write('README.md', 'other\n');
    other.commit('other');
    const otherExclude = readFileSync(join(other.root, '.git', 'info', 'exclude'), 'utf8');
    const gitVars = {
      GIT_DIR: join(other.root, '.git'),
      GIT_WORK_TREE: other.root,
      GIT_INDEX_FILE: join(other.root, '.git', 'index'),
      GIT_COMMON_DIR: join(other.root, '.git'),
    };
    const withVars = (repo: FixtureRepo): ExportContext => {
      const home = makeFixtureHome();
      const env = makeTestEnv({ home, cwd: repo.root, vars: { HOME: home, PATH: process.env.PATH, ...gitVars } });
      return { env, runner: gitRunner(), out: quietOut };
    };

    const clean = makeFixtureRepo();
    const ctx = withVars(clean);
    expect(await projectTop(ctx.env, ctx.runner)).toEqual({ ok: true, top: clean.root });
    expect(await exportSkills(ctx, { root: standInPackage(TWO, ['alpha']) })).toEqual({ ok: true });
    expect(readFileSync(join(clean.root, '.git', 'info', 'exclude'), 'utf8')).toContain('/.agents/skills/alpha/');
    expect(readFileSync(join(other.root, '.git', 'info', 'exclude'), 'utf8')).toBe(otherExclude);

    const tracked = makeFixtureRepo();
    tracked.write('.agents/skills/alpha/SKILL.md', 'committed\n');
    tracked.commit('track a skill');
    const result = await exportSkills(withVars(tracked), { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toMatch(/alpha \(tracked in git\)/);
  });
});

describe('fix round 1: tracked, modes, exclude order, and the lock', () => {
  it('a tracked folder whose name differs in letter case counts as tracked', async () => {
    const p = project();
    p.repo.write('.agents/skills/Alpha/SKILL.md', 'committed\n');
    p.repo.commit('track a skill in another case');
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toMatch(/alpha \(tracked in git\)/);
    expect(readFileSync(join(p.target, 'Alpha', 'SKILL.md'), 'utf8')).toBe('committed\n');
  });

  it('a tracked leftover temp folder is never removed, and is reported', async () => {
    const p = project();
    const leftover = join(p.target, '.trellis-crew-alpha-abc123');
    writeTree(leftover, { 'SKILL.md': 'staged\n' });
    writeMarker(leftover, 'alpha');
    p.repo.commit('track a leftover');
    const root = standInPackage(TWO, ['alpha']);
    const check = await checkSkills(p.ctx(), root);
    expect(check).toMatchObject({ ok: true, leftovers: [], strays: [leftover] });
    const lines: string[] = [];
    expect(await exportSkills(p.ctx((l) => lines.push(l)), { root })).toEqual({ ok: true });
    expect(existsSync(join(leftover, 'SKILL.md'))).toBe(true);
    expect(lines.join('\n')).toMatch(new RegExp(`warning: .*${basename(leftover)}.*left alone`));
  });

  it('copied folders always get the owner write bit, so a later run can replace them', async () => {
    const root = standInPackage({ alpha: { 'SKILL.md': 'a\n', 'refs/notes.md': 'n\n' } }, ['alpha']);
    const source = join(root, 'skills', 'alpha');
    chmodSync(join(source, 'refs'), 0o555);
    chmodSync(source, 0o555);
    try {
      const p = project();
      expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
      expect(mode(join(p.target, 'alpha')) & 0o200).toBe(0o200);
      expect(mode(join(p.target, 'alpha', 'refs')) & 0o200).toBe(0o200);
      expect(await checkSkills(p.ctx(), root)).toMatchObject({ ok: true, skills: [{ state: 'in-step' }] });
      const lines: string[] = [];
      const newer = standInPackage({ alpha: { 'SKILL.md': 'a v2\n' } }, ['alpha']);
      expect(await exportSkills(p.ctx((l) => lines.push(l)), { root: newer })).toEqual({ ok: true });
      expect(lines.join('\n')).not.toMatch(/warning/);
      expect(dotEntries(p.target)).toEqual([]);
      expect(readFileSync(join(p.target, 'alpha', 'SKILL.md'), 'utf8')).toBe('a v2\n');
    } finally {
      chmodSync(source, 0o755);
      chmodSync(join(source, 'refs'), 0o755);
    }
  });

  it('the exclude lines are added before the first copy, so a run that fails there still leaves them, and a later run succeeds', async () => {
    const p = project();
    const root = standInPackage(TWO, ['alpha', 'beta']);
    const failing: ExportFs = {
      ...nodeExportFs,
      mkdtemp: () => {
        throw new Error('copy refused');
      },
    };
    const result = await exportSkills(p.ctx(), { root, fs: failing });
    expect(!result.ok && result.message).toMatch(/copy refused/);
    expect(readFileSync(p.exclude, 'utf8')).toContain(block('/.agents/skills/alpha/', '/.agents/skills/beta/'));
    expect(existsSync(join(p.target, 'alpha'))).toBe(false);
    expect(await exportSkills(p.ctx(), { root })).toEqual({ ok: true });
    expect(p.repo.git('status', '--porcelain')).toBe('');
  });

  it('a stale removal takes the exclude line out only after the folder is gone', async () => {
    const p = project();
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha', 'beta']) })).toEqual({ ok: true });
    const events: string[] = [];
    const watching: ExportFs = {
      ...nodeExportFs,
      remove: (path) => {
        if (path === join(p.target, 'beta')) events.push(`remove beta, exclude has beta: ${readFileSync(p.exclude, 'utf8').includes('/.agents/skills/beta/')}`);
        nodeExportFs.remove(path);
      },
      writeAtomic: (path, text, m) => {
        if (path === p.exclude) events.push(`exclude write, has beta: ${text.includes('/.agents/skills/beta/')}`);
        nodeExportFs.writeAtomic(path, text, m);
      },
    };
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']), fs: watching })).toEqual({ ok: true });
    expect(events).toEqual(['remove beta, exclude has beta: true', 'exclude write, has beta: false']);
  });

  it('a held lock on the exclude file stops the export with a named step, and nothing changes', async () => {
    const p = project();
    const lock = `${p.exclude}.trellis-crew.lock`;
    writeFileSync(lock, 'held\n');
    const exclude = readFileSync(p.exclude, 'utf8');
    const result = await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']) });
    expect(!result.ok && result.message).toContain(lock);
    expect(!result.ok && result.message).toMatch(/lock/);
    expect(readFileSync(lock, 'utf8')).toBe('held\n');
    expect(readFileSync(p.exclude, 'utf8')).toBe(exclude);
    expect(existsSync(p.target)).toBe(false);
  });

  it('the lock is taken with an exclusive create and removed after each exclude edit', async () => {
    const p = project();
    const lock = `${p.exclude}.trellis-crew.lock`;
    const events: string[] = [];
    const watching: ExportFs = {
      ...nodeExportFs,
      writeFile: (path, text) => {
        if (path === lock) events.push('lock');
        nodeExportFs.writeFile(path, text);
      },
      writeAtomic: (path, text, m) => {
        if (path === p.exclude) events.push(`write, lock held: ${existsSync(lock)}`);
        nodeExportFs.writeAtomic(path, text, m);
      },
      remove: (path) => {
        if (path === lock) events.push('unlock');
        nodeExportFs.remove(path);
      },
    };
    expect(await exportSkills(p.ctx(), { root: standInPackage(TWO, ['alpha']), fs: watching })).toEqual({ ok: true });
    expect(events.slice(0, 3)).toEqual(['lock', 'write, lock held: true', 'unlock']);
    expect(existsSync(lock)).toBe(false);
  });
});

describe('CODEX_HOME', () => {
  it('the heuristic scan finds an assignment or an env key, and passes a read', () => {
    expect(codexHomeWrites('process.env.CODEX_HOME = dir;')).toHaveLength(1);
    expect(codexHomeWrites("env['CODEX_HOME'] = dir;")).toHaveLength(1);
    expect(codexHomeWrites('const vars = { ...env, CODEX_HOME: dir };')).toHaveLength(1);
    expect(codexHomeWrites("const vars = { 'CODEX_HOME': dir };")).toHaveLength(1);
    expect(codexHomeWrites('const vars = { ...env, CODEX_HOME };')).toHaveLength(1);
    expect(codexHomeWrites('codexHome: nonEmpty(process.env.CODEX_HOME),')).toEqual([]);
    expect(codexHomeWrites('if (process.env.CODEX_HOME === dir) {}')).toEqual([]);
    expect(codexHomeWrites(' * reader of HOME, PATH, CLAUDE_CONFIG_DIR, and CODEX_HOME. Every other')).toEqual([]);
  });

  it('no source file under src/ sets CODEX_HOME (heuristic scan)', () => {
    const files = sourceFiles(join(repoRoot, 'src'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(codexHomeWrites(readFileSync(file, 'utf8')), file).toEqual([]);
  });
});
