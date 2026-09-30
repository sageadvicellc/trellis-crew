import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import type { Runner, RunResult } from '../runner.ts';
import { withoutGitVars } from './codex-guard.ts';
import type { PluginCheck, PluginOutcome } from './types.ts';

/**
 * The export of the approved skills for Codex CLI, into the project.
 *
 * Codex CLI reads skills from `$CWD/.agents/skills`, `$CWD/../.agents/skills`,
 * `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`,
 * and then its built-in skills, as the Codex skills page says
 * (https://learn.chatgpt.com/docs/build-skills, read 2026-09-30). The
 * export writes only `<worktree top>/.agents/skills`. It never writes
 * `~/.agents/skills`, which every Codex session on the machine reads.
 * Under the workspace-write sandbox, "`<writable_root>/.agents` is
 * protected as read-only when it exists as a directory", as the Codex
 * approvals and security page says
 * (https://learn.chatgpt.com/docs/agent-approvals-security, read
 * 2026-09-30). So a Codex session cannot edit the copies.
 *
 * The approved skills are the `skills` list in the package's plugin
 * manifest. Each exported folder holds a marker file with the tree hash of
 * the folder. A folder is this package's own only when its marker names
 * this package and the skill, and the folder still hashes to the marker's
 * value. No step follows a symbolic link. The export keeps its folders out
 * of `git status` with a managed block in the local exclude file, and it
 * never writes over a tracked file.
 */

/** The marker file in each exported skill folder. */
export const SKILL_MARKER = '.trellis-crew-skill.json';
/** The name prefix of the temp folders an export makes beside the skills. */
export const TEMP_PREFIX = '.trellis-crew-';
/** The first line of the managed block in the local exclude file. */
export const EXCLUDE_BEGIN = '# >>> trellis-crew skills (managed) >>>';
/** The last line of the managed block in the local exclude file. */
export const EXCLUDE_END = '# <<< trellis-crew skills (managed) <<<';
const OWNER = 'trellis-crew';
const MARKER_MAX_BYTES = 4096;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** The mode bits a copy keeps and the hash covers: no group or other write, no special bits. */
const MODE_MASK = 0o755;
/** The owner write bit, which a copied folder always keeps, so a later run can rename and remove it. */
const OWNER_WRITE = 0o200;
/** The shape of a temp folder: the prefix, a skill name, the six characters mkdtemp adds, and `-old` for a swapped-out copy. */
const TEMP_SHAPE = /^\.trellis-crew-(.+)-[A-Za-z0-9]{6}(?:-old)?$/;
const EXCLUDE_LINE = /^\/\.agents\/skills\/([^/]+)\/$/;
const GIT_TIMEOUT_MS = 30_000;

/** The folder the export writes: `.agents/skills` at the project's worktree top. */
export function projectSkillsDir(top: string): string {
  return join(top, '.agents', 'skills');
}

/** The package root, which holds `.claude-plugin/plugin.json` and `skills/`. */
export function packageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? describeError(error);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The mode a copy gets: mode & 0o755, and the owner write bit for a folder. */
function copyMode(stat: Stats): number {
  const bits = stat.mode & MODE_MASK;
  return stat.isDirectory() ? bits | OWNER_WRITE : bits;
}

const isUnder = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** Where a command is run, and what it may run. The export and the check take this. */
export interface ExportContext {
  env: Env;
  runner: Runner;
  out: (line: string) => void;
}

type Git = (args: readonly string[]) => Promise<RunResult>;

/**
 * Runs git in `cwd` with every GIT_ variable removed. A GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE, or GIT_COMMON_DIR from the parent would
 * point these git calls at another repository.
 */
function gitIn(ctx: Pick<ExportContext, 'env' | 'runner'>, cwd: string): Git {
  const env = withoutGitVars(ctx.env.vars);
  return (args) => ctx.runner.run('git', args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });
}

function gitFailure(what: string, result: RunResult): string {
  const detail = result.error ?? (result.timedOut ? 'it timed out' : result.stderr.trim() || `exit code ${String(result.code)}`);
  return `${what} failed (${detail})`;
}

export type TopResult = { ok: true; top: string } | { ok: false; message: string };

/**
 * The project folder, which must be the top of a git worktree. The Env cwd
 * after realpath must equal `git rev-parse --show-toplevel` after realpath,
 * and it is never the home folder or `/`.
 *
 * This guard stays apart from `workdirProblem` in
 * `src/adapters/codex-guard.ts` on purpose. It checks less: only the top,
 * the home folder, and `/`, with no check of git settings. And plain
 * `install` runs it on its own; only `up` and a session start run the
 * working-folder check.
 */
export async function projectTop(env: Env, runner: Runner): Promise<TopResult> {
  let folder: string;
  try {
    folder = realpathSync(env.cwd);
  } catch (error) {
    return { ok: false, message: `the project folder ${env.cwd} could not be read (${describeError(error)})` };
  }
  if (folder === sep) return { ok: false, message: `the project folder ${folder} is the root folder, so no skill was exported` };
  let home: string | undefined;
  try {
    home = realpathSync(env.home);
  } catch {
    home = env.home;
  }
  if (folder === home) return { ok: false, message: `the project folder ${folder} is your home folder, so no skill was exported` };
  const result = await gitIn({ env, runner }, folder)(['rev-parse', '--show-toplevel']);
  if (result.code !== 0) return { ok: false, message: `the project folder ${folder} is not inside a git worktree` };
  const named = result.stdout.trim();
  let top: string;
  try {
    if (named === '') throw new Error('git named no top folder');
    top = realpathSync(named);
  } catch (error) {
    return { ok: false, message: `the git worktree top of ${folder} could not be read (${describeError(error)})` };
  }
  if (top !== folder) return { ok: false, message: `the project folder ${folder} is not the top of its git worktree, which is ${top}. Run the command there` };
  return { ok: true, top };
}

export interface ApprovedSkill {
  name: string;
  /** The skill folder in the package. */
  source: string;
}

export type ApprovedResult = { ok: true; skills: ApprovedSkill[] } | { ok: false; message: string };

/** The skill name in one manifest entry, such as `./skills/department-lead/`, or undefined. */
function skillNameOf(entry: unknown): string | undefined {
  if (typeof entry !== 'string') return undefined;
  const name = /^(?:\.\/)?skills\/([^/]+)\/?$/.exec(entry)?.[1];
  return name !== undefined && SKILL_NAME.test(name) ? name : undefined;
}

/** Reads the approved skills from the plugin manifest under `root`. Names are deduped case-blind. */
export function approvedSkills(root: string): ApprovedResult {
  const manifestPath = join(root, '.claude-plugin', 'plugin.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, message: `the plugin manifest ${manifestPath} could not be read (${describeError(error)})` };
  }
  const list = (manifest as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list)) return { ok: false, message: `the plugin manifest ${manifestPath} has no skills list` };
  if (list.length === 0) return { ok: false, message: `the plugin manifest ${manifestPath} has an empty skills list` };
  const skills: ApprovedSkill[] = [];
  for (const entry of list) {
    const name = skillNameOf(entry);
    if (name === undefined) {
      return { ok: false, message: `the plugin manifest lists ${JSON.stringify(entry)}, which is not a skill folder under skills/` };
    }
    if (skills.some((s) => same(s.name, name))) continue;
    const source = join(root, 'skills', name);
    let stat: Stats | undefined;
    try {
      stat = lstatOrUndefined(source);
    } catch (error) {
      return { ok: false, message: `the approved skill ${name} could not be read (${describeError(error)})` };
    }
    if (stat?.isDirectory() !== true) return { ok: false, message: `the approved skill ${name} has no folder at ${source}` };
    skills.push({ name, source });
  }
  return { ok: true, skills };
}

interface Entry {
  rel: string;
  abs: string;
  stat: Stats;
}

/** Each entry under `dir`, sorted by relative path, with the top marker file left out. Refuses a link or a special file. */
function walk(dir: string): Entry[] {
  const found: Entry[] = [];
  const visit = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (childRel === SKILL_MARKER) continue;
      const childAbs = join(abs, name);
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) throw new Error(`the skill tree holds a symbolic link, which is refused: ${childAbs}`);
      if (stat.isDirectory()) {
        found.push({ rel: childRel, abs: childAbs, stat });
        visit(childAbs, childRel);
      } else if (stat.isFile()) {
        found.push({ rel: childRel, abs: childAbs, stat });
      } else {
        throw new Error(`the skill tree holds a special file, which is refused: ${childAbs}`);
      }
    }
  };
  visit(dir, '');
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * SHA-256 over a skill folder: each relative path in sorted order, its
 * type, its mode, and each file's length and bytes. The mode is the copy's
 * mode: mode & 0o755 for a file, and that with the owner write bit for a
 * folder. The marker file is left out, so a copy hashes the same as its
 * source.
 */
export function treeHash(dir: string): string {
  const hash = createHash('sha256');
  for (const entry of walk(dir)) {
    const mode = copyMode(entry.stat).toString(8);
    if (entry.stat.isDirectory()) {
      hash.update(`dir\0${mode}\0${entry.rel}\0`);
      continue;
    }
    const bytes = readFileSync(entry.abs);
    hash.update(`file\0${mode}\0${entry.rel}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** Reads at most MARKER_MAX_BYTES + 1 bytes, and never through a link. */
function readSmall(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MARKER_MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

type RawMarker = { kind: 'none' } | { kind: 'foreign' } | { kind: 'unreadable'; reason: string } | { kind: 'parsed'; data: Record<string, unknown> };

/** Reads the marker file in `dir`. A missing file or bad JSON is no marker; a link, a folder, a large file, or a non-object is foreign. */
function readRawMarker(dir: string): RawMarker {
  const path = join(dir, SKILL_MARKER);
  let text: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return { kind: 'foreign' };
    text = readSmall(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { kind: 'none' };
    if (code === 'ELOOP') return { kind: 'foreign' };
    return { kind: 'unreadable', reason: `marker unreadable (${code})` };
  }
  if (Buffer.byteLength(text) > MARKER_MAX_BYTES) return { kind: 'foreign' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'none' };
  }
  if (typeof data !== 'object' || data === null) return { kind: 'foreign' };
  return { kind: 'parsed', data: data as Record<string, unknown> };
}

type Marker = { kind: 'none' } | { kind: 'foreign' } | { kind: 'unreadable'; reason: string } | { kind: 'ours'; sha256: string };

function readMarker(dir: string, skill: string): Marker {
  const raw = readRawMarker(dir);
  if (raw.kind !== 'parsed') return raw;
  const { owner, skill: named, sha256 } = raw.data;
  if (owner !== OWNER || typeof named !== 'string' || !same(named, skill)) return { kind: 'foreign' };
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return { kind: 'foreign' };
  return { kind: 'ours', sha256 };
}

/** What is at a skill path. */
type Found =
  | { kind: 'absent' }
  | { kind: 'link' }
  | { kind: 'not-owned' }
  | { kind: 'edited' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'owned'; sha256: string }
  | { kind: 'unmarked-copy' };

/**
 * Looks at `path` for `skill`. `sourceHash` is the package's hash for that
 * skill: an unmarked folder that matches it exactly is a copy this package
 * made before markers existed.
 */
function classify(path: string, skill: string, sourceHash: string | undefined): Found {
  let stat: Stats | undefined;
  try {
    stat = lstatOrUndefined(path);
  } catch (error) {
    return { kind: 'unreadable', reason: `unreadable (${errorCode(error)})` };
  }
  if (stat === undefined) return { kind: 'absent' };
  if (stat.isSymbolicLink()) return { kind: 'link' };
  if (!stat.isDirectory()) return { kind: 'not-owned' };
  const marker = readMarker(path, skill);
  if (marker.kind === 'foreign') return { kind: 'not-owned' };
  if (marker.kind === 'unreadable') return marker;
  if (marker.kind === 'none') {
    if (sourceHash === undefined) return { kind: 'not-owned' };
    try {
      return treeHash(path) === sourceHash ? { kind: 'unmarked-copy' } : { kind: 'not-owned' };
    } catch {
      return { kind: 'not-owned' };
    }
  }
  let hash: string;
  try {
    hash = treeHash(path);
  } catch (error) {
    return { kind: 'unreadable', reason: describeError(error) };
  }
  return hash === marker.sha256 ? { kind: 'owned', sha256: hash } : { kind: 'edited' };
}

const TRACKED = 'tracked in git';

/** The label for a folder the export must leave alone, the same in install and in the check. */
function blockLabel(found: Found, tracked: boolean): string | undefined {
  if (tracked) return TRACKED;
  switch (found.kind) {
    case 'link':
      return 'a symbolic link';
    case 'not-owned':
      return 'a folder trellis-crew does not own';
    case 'edited':
      return 'a trellis-crew copy edited since export';
    case 'unreadable':
      return `unreadable: ${found.reason}`;
    default:
      return undefined;
  }
}

/** Why a path is refused as a folder on the way to the skills, or undefined when it is a real folder or absent. */
function refusedFolder(path: string): string | undefined {
  const stat = lstatOrUndefined(path);
  if (stat === undefined || stat.isDirectory()) return undefined;
  return stat.isSymbolicLink() ? `${path} is a symbolic link, which is not followed` : `${path} is not a folder`;
}

/** The package's hash for a skill folder that is not approved, or undefined. */
function packageHash(root: string, name: string): string | undefined {
  try {
    const source = join(root, 'skills', name);
    return lstatOrUndefined(source)?.isDirectory() === true ? treeHash(source) : undefined;
  } catch {
    return undefined;
  }
}

interface Other {
  name: string;
  path: string;
  found: Found;
  sourceHash: string | undefined;
}

/**
 * Each folder in `skillsDir` that is not approved and that this package
 * owns, or once owned. Dot-prefixed names, links, and files are never read.
 */
function otherFolders(skillsDir: string, approved: readonly ApprovedSkill[], root: string): Other[] {
  if (lstatOrUndefined(skillsDir) === undefined) return [];
  const others: Other[] = [];
  const entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (approved.some((s) => same(s.name, entry.name))) continue;
    const path = join(skillsDir, entry.name);
    const sourceHash = packageHash(root, entry.name);
    const found = classify(path, entry.name, sourceHash);
    if (found.kind === 'absent' || found.kind === 'link' || found.kind === 'not-owned') continue;
    others.push({ name: entry.name, path, found, sourceHash });
  }
  return others;
}

interface Leftovers {
  /** Temp folders this code made: the exact shape, with a marker that names trellis-crew and the skill and matches the tree. */
  removable: string[];
  /** Folders with the exact shape but no marker, or a marker that does not match. They are reported and left alone. */
  strays: string[];
}

/**
 * Real folders in `skillsDir` with the exact temp shape for an approved
 * skill, left by an export that did not finish. Only a folder whose marker
 * proves it is this package's own copy is removable. A folder with no
 * marker, such as a user's `.trellis-crew-alpha-backup`, is only reported.
 * Any other dot name, such as `.trellis-crew-backup`, is never read.
 * Folders the current run makes are cleaned up by its own stage and swap
 * code, not here.
 */
function leftoverFolders(skillsDir: string, approved: readonly ApprovedSkill[]): Leftovers {
  const found: Leftovers = { removable: [], strays: [] };
  if (lstatOrUndefined(skillsDir) === undefined) return found;
  const entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = TEMP_SHAPE.exec(entry.name)?.[1];
    const skill = name === undefined ? undefined : approved.find((s) => same(s.name, name));
    if (skill === undefined) continue;
    const path = join(skillsDir, entry.name);
    const ours = classify(path, skill.name, undefined).kind === 'owned';
    (ours ? found.removable : found.strays).push(path);
  }
  return found;
}

/**
 * The file operations the export writes with. Every write goes through
 * this, so a test can record each path. Tests pass a stand-in.
 */
export interface ExportFs {
  mkdir(path: string, mode?: number): void;
  /** Makes a fresh folder whose name is `prefix` and six random characters, and returns its path. */
  mkdtemp(prefix: string): string;
  /** Copies a file, and fails when `to` exists. */
  copyFile(from: string, to: string): void;
  /** Writes a new file with mode 0644, and fails when it exists. */
  writeFile(path: string, text: string): void;
  /** Replaces a file atomically with the given mode. */
  writeAtomic(path: string, text: string, mode: number): void;
  chmod(path: string, mode: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

export const nodeExportFs: ExportFs = {
  mkdir: (path, mode) => mkdirSync(path, mode === undefined ? {} : { mode }),
  mkdtemp: (prefix) => mkdtempSync(prefix),
  copyFile: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
  writeFile: (path, text) => writeFileSync(path, text, { flag: 'wx', mode: 0o644 }),
  writeAtomic: (path, text, mode) => writeFileAtomic(path, text, mode),
  chmod: (path, mode) => chmodSync(path, mode),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

/** A folder on the way to the skills, fixed by its device and inode once the export has made or found it. */
interface Pin {
  path: string;
  dev: bigint;
  ino: bigint;
}

/** Checks that `path` is a real folder that resolves to `expected`, and records its device and inode. */
function pinFolder(path: string, expected: string): Pin {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`${path} is a symbolic link, which is not followed`);
  if (!stat.isDirectory()) throw new Error(`${path} is not a folder`);
  const real = realpathSync(path);
  if (real !== expected) throw new Error(`${path} resolves to ${real}, not ${expected}`);
  return { path, dev: stat.dev, ino: stat.ino };
}

/** Throws when a pinned folder is gone, is now a link, or is another folder than the one pinned. */
function checkPins(pins: readonly Pin[]): void {
  for (const pin of pins) {
    let stat;
    try {
      stat = lstatSync(pin.path, { bigint: true });
    } catch {
      stat = undefined;
    }
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== pin.dev || stat.ino !== pin.ino) {
      throw new Error(`${pin.path} changed during the export, so the export stopped`);
    }
  }
}

/**
 * An ExportFs that checks every pin before each operation. A folder that a
 * racer swaps for a link, or for another folder, stops the export before
 * the next write can land through it.
 */
function pinnedFs(fsx: ExportFs, pins: readonly Pin[]): ExportFs {
  return {
    mkdir: (path, mode) => (checkPins(pins), fsx.mkdir(path, mode)),
    mkdtemp: (prefix) => (checkPins(pins), fsx.mkdtemp(prefix)),
    copyFile: (from, to) => (checkPins(pins), fsx.copyFile(from, to)),
    writeFile: (path, text) => (checkPins(pins), fsx.writeFile(path, text)),
    writeAtomic: (path, text, mode) => (checkPins(pins), fsx.writeAtomic(path, text, mode)),
    chmod: (path, mode) => (checkPins(pins), fsx.chmod(path, mode)),
    rename: (from, to) => (checkPins(pins), fsx.rename(from, to)),
    remove: (path) => (checkPins(pins), fsx.remove(path)),
  };
}

/** The lock file beside the exclude file, in the same checked folder. */
export function excludeLockPath(excludePath: string): string {
  return `${excludePath}.trellis-crew.lock`;
}

function lockHeld(lock: string): Error {
  return new Error(`the git exclude file is locked by ${lock}. If no other trellis-crew run is going, remove that lock file, then run the command again`);
}

/** Runs `edit` while holding the exclude lock, which is made with an exclusive create and removed after. */
function withExcludeLock(excludePath: string, fsx: ExportFs, edit: () => void): void {
  const lock = excludeLockPath(excludePath);
  try {
    fsx.writeFile(lock, `${process.pid}\n`);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw lockHeld(lock);
    throw error;
  }
  let failed = true;
  try {
    edit();
    failed = false;
  } finally {
    try {
      fsx.remove(lock);
    } catch (error) {
      if (!failed) throw new Error(`the exclude lock ${lock} could not be removed (${describeError(error)})`, { cause: error });
    }
  }
}

/** An error for a cleanup that failed after `first`: it keeps `first` as the cause and names the path. */
function withCleanup(first: unknown, path: string, cleanup: unknown): Error {
  return new Error(`${describeError(first)}. The temp folder ${path} could not be removed (${describeError(cleanup)})`, {
    cause: first,
  });
}

/** Copies a tree of plain folders and files. Folders are 0o700 while it copies; the copy modes are applied last, deepest first. */
function copyTree(source: string, dest: string, fsx: ExportFs): void {
  const entries = walk(source);
  for (const entry of entries) {
    const to = join(dest, ...entry.rel.split('/'));
    if (entry.stat.isDirectory()) fsx.mkdir(to, 0o700);
    else fsx.copyFile(entry.abs, to);
  }
  const deepestFirst = [...entries].sort((a, b) => b.rel.split('/').length - a.rel.split('/').length);
  for (const entry of deepestFirst) fsx.chmod(join(dest, ...entry.rel.split('/')), copyMode(entry.stat));
}

function markerText(skill: string, sha256: string): string {
  return `${JSON.stringify({ owner: OWNER, skill, sha256 }, null, 2)}\n`;
}

/** Copies one skill into a fresh temp folder in `skillsDir`, writes its marker, and returns the temp path. */
function stage(skillsDir: string, skill: ApprovedSkill, sourceHash: string, fsx: ExportFs): string {
  const temp = fsx.mkdtemp(join(skillsDir, `${TEMP_PREFIX}${skill.name}-`));
  try {
    copyTree(skill.source, temp, fsx);
    if (treeHash(temp) !== sourceHash) throw new Error(`the copy of ${skill.name} does not match its source`);
    fsx.writeFile(join(temp, SKILL_MARKER), markerText(skill.name, sourceHash));
    fsx.chmod(temp, copyMode(lstatSync(skill.source)));
    return temp;
  } catch (error) {
    try {
      fsx.remove(temp);
    } catch (cleanup) {
      throw withCleanup(error, temp, cleanup);
    }
    throw error;
  }
}

/** Puts the old copy back after `reason`, then throws. A failed rollback names both errors and where the old copy is. */
function restore(old: string, dest: string, fsx: ExportFs, reason: unknown): never {
  try {
    fsx.rename(old, dest);
  } catch (rollback) {
    throw new Error(
      `${describeError(reason)}. Putting the old copy back at ${dest} also failed (${describeError(rollback)}), so the old copy is at ${old}`,
      { cause: reason },
    );
  }
  throw reason;
}

/**
 * Puts the staged folder `temp` at `dest`. For `copy`, nothing may be at
 * `dest`. For `replace`, `dest` must be an owned copy: it is renamed to
 * `<temp>-old`, checked again there, and removed once the new copy is in
 * place. Exported for tests.
 */
export function swapIn(temp: string, dest: string, skill: string, kind: 'copy' | 'replace', fsx: ExportFs, out: (line: string) => void): void {
  const changed = new Error(`${dest} changed during the export, so it was left alone`);
  const now = classify(dest, skill, undefined);
  if (kind === 'copy') {
    if (now.kind !== 'absent') throw changed;
    fsx.rename(temp, dest);
    return;
  }
  if (now.kind !== 'owned') throw changed;
  const old = `${temp}-old`;
  fsx.rename(dest, old);
  if (classify(old, skill, undefined).kind !== 'owned') {
    restore(old, dest, fsx, new Error(`${dest} changed during the export, so it was put back and nothing was removed`));
  }
  try {
    fsx.rename(temp, dest);
  } catch (error) {
    restore(old, dest, fsx, error);
  }
  try {
    fsx.remove(old);
  } catch (error) {
    out(`warning: the new copy of ${skill} is installed, but the old copy at ${old} could not be removed (${describeError(error)}). Remove it by hand.`);
  }
}

/* ---------- The local exclude file ---------- */

export type ExcludeUpdate = { ok: true; text: string; warnings: string[] } | { ok: false; message: string };

export interface ExcludeChange {
  /** Skills whose line the block must hold. */
  add: readonly string[];
  /** Skills whose line the block must drop. */
  remove: readonly string[];
  /** Every approved or stale skill name. Only a line for one of these is this code's own. */
  known: readonly string[];
}

/**
 * Rewrites the managed block in an exclude file's text. Lines outside the
 * block never change. Inside it, only a `/.agents/skills/<name>/` line for
 * a known name is this code's own; any other line is kept and warned
 * about. A new block goes at the top, so the user's part, and any missing
 * trailing newline in it, stays byte for byte. An empty block is removed
 * whole. A begin line with no end line, or two blocks, is refused.
 */
export function updateExcludeText(text: string, change: ExcludeChange): ExcludeUpdate {
  const segments = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const content = (segment: string): string => segment.replace(/\r?\n$/, '');
  const begins = segments.flatMap((s, i) => (content(s) === EXCLUDE_BEGIN ? [i] : []));
  const ends = segments.flatMap((s, i) => (content(s) === EXCLUDE_END ? [i] : []));
  if (begins.length > 1 || ends.length > 1) return { ok: false, message: 'it has two managed blocks' };
  if (begins.length !== ends.length) return { ok: false, message: begins.length === 1 ? 'its managed block has a begin line with no end line' : 'its managed block has an end line with no begin line' };
  const begin = begins[0];
  const end = ends[0];
  if (begin !== undefined && end !== undefined && end < begin) return { ok: false, message: 'its managed block lines are out of order' };

  const known = new Set(change.known.map((n) => n.toLowerCase()));
  const managed = new Map<string, string>();
  const others: string[] = [];
  const warnings: string[] = [];
  const inner = begin !== undefined && end !== undefined ? segments.slice(begin + 1, end).map(content) : [];
  for (const line of inner) {
    const name = EXCLUDE_LINE.exec(line)?.[1];
    if (name !== undefined && known.has(name.toLowerCase())) {
      managed.set(name.toLowerCase(), name);
    } else {
      others.push(line);
      if (line.trim() !== '') warnings.push(`the managed block holds a line trellis-crew did not write, which it keeps: ${line}`);
    }
  }
  for (const name of change.add) managed.set(name.toLowerCase(), name);
  for (const name of change.remove) managed.delete(name.toLowerCase());
  const lines = [...managed.values()].sort().map((name) => `/.agents/skills/${name}/`);

  const empty = lines.length === 0 && others.length === 0;
  const blockText = empty ? '' : [EXCLUDE_BEGIN, ...others, ...lines, EXCLUDE_END].join('\n') + '\n';
  if (begin === undefined || end === undefined) return { ok: true, text: blockText + text, warnings };
  const before = segments.slice(0, begin).join('');
  const after = segments.slice(end + 1).join('');
  return { ok: true, text: before + blockText + after, warnings };
}

interface ExcludeFile {
  path: string;
  text: string;
  /** The file's mode, or undefined when the file is missing. */
  mode: number | undefined;
  /** The realpath of the file's folder, `.git/info`, under the git common folder. The export pins that folder to it. */
  infoReal: string;
}

/**
 * Finds and reads the local exclude file with `git rev-parse --git-path
 * info/exclude` in the top. Refuses a link at `info` or at the file, and a
 * file whose realpath is not under `git rev-parse --git-common-dir`, which
 * holds for a linked worktree too.
 */
async function readExclude(top: string, git: Git): Promise<{ ok: true; file: ExcludeFile } | { ok: false; message: string }> {
  const named = await git(['rev-parse', '--git-path', 'info/exclude']);
  if (named.code !== 0) return { ok: false, message: gitFailure('git rev-parse --git-path info/exclude', named) };
  const common = await git(['rev-parse', '--git-common-dir']);
  if (common.code !== 0) return { ok: false, message: gitFailure('git rev-parse --git-common-dir', common) };
  const path = resolve(top, named.stdout.trim());
  const commonDir = realpathSync(resolve(top, common.stdout.trim()));
  const info = dirname(path);
  const refused = refusedFolder(info);
  if (refused !== undefined) return { ok: false, message: `the git exclude folder ${refused}` };
  const stat = lstatOrUndefined(path);
  if (stat?.isSymbolicLink() === true) return { ok: false, message: `the git exclude file ${path} is a symbolic link, which is not followed` };
  if (stat !== undefined && !stat.isFile()) return { ok: false, message: `the git exclude file ${path} is not a file` };
  const infoReal = lstatOrUndefined(info) !== undefined ? realpathSync(info) : join(realpathSync(dirname(info)), basename(info));
  const real = stat !== undefined ? realpathSync(path) : join(infoReal, basename(path));
  if (!isUnder(real, commonDir) || !isUnder(infoReal, commonDir)) return { ok: false, message: `the git exclude file ${path} is not under the git folder ${commonDir}` };
  return { ok: true, file: { path, text: stat === undefined ? '' : readFileSync(path, 'utf8'), mode: stat === undefined ? undefined : stat.mode & 0o777, infoReal } };
}

/* ---------- The survey: everything read before anything is written ---------- */

interface Target {
  skill: ApprovedSkill;
  sourceHash: string;
  path: string;
  found: Found;
  tracked: boolean;
}

interface Survey {
  top: string;
  skillsDir: string;
  approved: ApprovedSkill[];
  targets: Target[];
  others: (Other & { tracked: boolean })[];
  leftovers: Leftovers;
  git: Git;
}

type SurveyResult = { ok: true; survey: Survey } | { ok: false; message: string };

/** Reads the project and the package. It writes nothing. */
async function survey(ctx: Pick<ExportContext, 'env' | 'runner'>, root: string): Promise<SurveyResult> {
  const found = await projectTop(ctx.env, ctx.runner);
  if (!found.ok) return found;
  const { top } = found;
  const git = gitIn(ctx, top);
  const approved = approvedSkills(root);
  if (!approved.ok) return approved;
  const skillsDir = projectSkillsDir(top);
  for (const folder of [dirname(skillsDir), skillsDir]) {
    const refused = refusedFolder(folder);
    if (refused !== undefined) return { ok: false, message: refused };
  }
  // Case-blind, since a case-blind file system shows `Alpha/` at `alpha/`.
  const tracked = async (name: string): Promise<boolean> => {
    const listed = await git(['ls-files', '-z', '--', `:(icase).agents/skills/${name}`]);
    if (listed.code !== 0) throw new Error(gitFailure(`git ls-files for ${name}`, listed));
    return listed.stdout !== '';
  };
  const targets: Target[] = [];
  for (const skill of approved.skills) {
    const sourceHash = treeHash(skill.source);
    const path = join(skillsDir, skill.name);
    targets.push({ skill, sourceHash, path, found: classify(path, skill.name, sourceHash), tracked: await tracked(skill.name) });
  }
  const others: (Other & { tracked: boolean })[] = [];
  for (const other of otherFolders(skillsDir, approved.skills, root)) others.push({ ...other, tracked: await tracked(other.name) });
  // A tracked leftover is never removed: it is reported and left alone.
  const shaped = leftoverFolders(skillsDir, approved.skills);
  const leftovers: Leftovers = { removable: [], strays: [...shaped.strays] };
  for (const path of shaped.removable) (await tracked(basename(path)) ? leftovers.strays : leftovers.removable).push(path);
  leftovers.strays.sort();
  return { ok: true, survey: { top, skillsDir, approved: approved.skills, targets, others, leftovers, git } };
}

/* ---------- The export ---------- */

export interface ExportOptions {
  /** The package root. Tests pass a stand-in package. */
  root?: string;
  /** The file operations for every write. Tests pass a stand-in. */
  fs?: ExportFs;
}

interface Action {
  target: Target;
  kind: 'copy' | 'replace' | 'adopt';
}

/**
 * Exports the approved skills into `.agents/skills` at the project's
 * worktree top. It first reads everything. When any target is not this
 * package's own, was edited since the export, or is tracked in git, or
 * the exclude file is broken, it changes nothing and names each one.
 * Otherwise it removes its own leftover temp folders, copies each approved
 * skill, replaces each owned copy, adopts each exact unmarked copy, removes
 * each owned folder whose skill is no longer approved, and updates the
 * managed block in the local exclude file. Nothing else is touched.
 */
export async function exportSkills(ctx: ExportContext, options: ExportOptions = {}): Promise<PluginOutcome> {
  const root = options.root ?? packageRoot();
  const fsx = options.fs ?? nodeExportFs;
  const fail = (reason: string): PluginOutcome => ({ ok: false, message: `the skill export stopped: ${reason}` });

  let plan: Survey;
  let actions: Action[];
  let exclude: ExcludeFile;
  try {
    const surveyed = await survey(ctx, root);
    if (!surveyed.ok) return fail(surveyed.message);
    plan = surveyed.survey;
    const blocked: string[] = [];
    actions = [];
    for (const target of plan.targets) {
      const label = blockLabel(target.found, target.tracked);
      if (label !== undefined) blocked.push(`${target.skill.name} (${label}) at ${target.path}`);
      else actions.push({ target, kind: target.found.kind === 'absent' ? 'copy' : target.found.kind === 'unmarked-copy' ? 'adopt' : 'replace' });
    }
    for (const other of plan.others) {
      const label = blockLabel(other.found, other.tracked);
      if (label !== undefined) blocked.push(`${other.name} (${label}) at ${other.path}`);
    }
    if (blocked.length > 0) {
      return fail(`${blocked.join('; ')}. It was left alone, so nothing was changed. Move or rename it, then run the command again.`);
    }
    const read = await readExclude(plan.top, plan.git);
    if (!read.ok) return fail(`${read.message}, so nothing was changed`);
    exclude = read.file;
    const known = [...plan.approved.map((s) => s.name), ...plan.others.map((o) => o.name)];
    const trial = updateExcludeText(exclude.text, { add: [], remove: [], known });
    if (!trial.ok) return fail(`the git exclude file ${exclude.path}: ${trial.message}, so nothing was changed`);
    if (lstatOrUndefined(excludeLockPath(exclude.path)) !== undefined) return fail(`${lockHeld(excludeLockPath(exclude.path)).message}. Nothing was changed`);
  } catch (error) {
    return fail(describeError(error));
  }

  const { skillsDir, top } = plan;
  const done: string[] = [];
  const removed: string[] = [];
  const approvedNames = plan.approved.map((s) => s.name);
  const known = [...approvedNames, ...plan.others.map((o) => o.name)];
  let gfs: ExportFs = fsx;
  // Adds each approved skill's line, and drops the line of each skill already removed, under the lock.
  const writeExclude = (): void => {
    withExcludeLock(exclude.path, gfs, () => {
      const current = lstatOrUndefined(exclude.path) === undefined ? '' : readFileSync(exclude.path, 'utf8');
      const next = updateExcludeText(current, { add: approvedNames, remove: removed, known });
      if (!next.ok) throw new Error(`the git exclude file ${exclude.path}: ${next.message}`);
      for (const warning of next.warnings) ctx.out(`warning: ${exclude.path}: ${warning}`);
      if (next.text === current) return;
      gfs.writeAtomic(exclude.path, next.text, exclude.mode ?? 0o644);
    });
  };
  try {
    // Make the folders, then check and pin each one before any other write.
    // A racer that makes `.agents` a link, or swaps either folder later, stops
    // the export before a write can land through it.
    const realTop = realpathSync(top);
    const agents = dirname(skillsDir);
    if (lstatOrUndefined(agents) === undefined) fsx.mkdir(agents);
    const agentsPin = pinFolder(agents, join(realTop, '.agents'));
    if (lstatOrUndefined(skillsDir) === undefined) pinnedFs(fsx, [agentsPin]).mkdir(skillsDir);
    const skillsPin = pinFolder(skillsDir, projectSkillsDir(realTop));
    // Pin `.git/info` too, against its realpath under the git common folder,
    // so the lock and the exclude write cannot follow a link swapped in later.
    const info = dirname(exclude.path);
    if (lstatOrUndefined(info) === undefined) pinnedFs(fsx, [agentsPin, skillsPin]).mkdir(info);
    const infoPin = pinFolder(info, exclude.infoReal);
    gfs = pinnedFs(fsx, [agentsPin, skillsPin, infoPin]);

    // The exclude lines go in before the first copy, so no copy shows in git status.
    writeExclude();
    for (const leftover of plan.leftovers.removable) {
      gfs.remove(leftover);
      ctx.out(`Removed the leftover temp folder ${leftover}.`);
    }
    for (const stray of plan.leftovers.strays) {
      ctx.out(`warning: ${stray} is named like a trellis-crew temp folder but holds no matching trellis-crew marker, so it was left alone.`);
    }
    for (const { target, kind } of actions) {
      const { skill, sourceHash, path: dest } = target;
      if (kind === 'adopt') {
        if (classify(dest, skill.name, sourceHash).kind !== 'unmarked-copy') throw new Error(`${dest} changed during the export, so it was left alone`);
        gfs.writeAtomic(join(dest, SKILL_MARKER), markerText(skill.name, sourceHash), 0o644);
        ctx.out(`Adopted the unmarked copy of ${skill.name} at ${dest}.`);
      } else {
        const temp = stage(skillsDir, skill, sourceHash, gfs);
        try {
          swapIn(temp, dest, skill.name, kind, gfs, ctx.out);
        } catch (error) {
          try {
            gfs.remove(temp);
          } catch (cleanup) {
            throw withCleanup(error, temp, cleanup);
          }
          throw error;
        }
      }
      done.push(skill.name);
    }

    const refused = refusedFolder(skillsDir);
    if (refused !== undefined) throw new Error(`${refused}, so no stale skill was removed`);
    const expected = projectSkillsDir(realpathSync(top));
    if (realpathSync(skillsDir) !== expected) throw new Error(`${skillsDir} no longer resolves to ${expected}, so no stale skill was removed`);
    for (const other of plan.others) {
      const again = classify(other.path, other.name, other.sourceHash).kind;
      if (again !== 'owned' && again !== 'unmarked-copy') throw new Error(`${other.path} changed during the export, so it was left alone`);
      gfs.remove(other.path);
      removed.push(other.name);
      ctx.out(`Removed the stale skill ${other.name}, which this package no longer ships.`);
    }
    // A stale skill's line comes out only after its folder is gone.
    writeExclude();
  } catch (error) {
    let note = '';
    if (removed.length > 0) {
      try {
        writeExclude();
      } catch (excludeError) {
        note = ` The git exclude file was not updated (${describeError(excludeError)}).`;
      }
    }
    const already = done.length > 0 ? ` Already copied: ${done.join(', ')}.` : '';
    return fail(`${describeError(error)}.${already}${note} Run trellis-crew update again to finish.`);
  }
  ctx.out(`Copied the approved trellis-crew skills into ${skillsDir}.`);
  return { ok: true };
}

/* ---------- The drift check ---------- */

export type SkillState = 'in-step' | 'drifted' | 'missing' | 'not-owned' | 'edited' | 'unreadable' | 'unmarked' | 'stale';

export interface SkillStatus {
  skill: string;
  state: SkillState;
  path: string;
  /** For not-owned, what is there; for unreadable, the error. */
  detail?: string;
}

export type SkillCheck =
  | { ok: true; skills: SkillStatus[]; leftovers: string[]; strays: string[]; notes: string[] }
  | { ok: false; message: string };

function statusOf(skill: string, path: string, found: Found, sourceHash: string, tracked: boolean): SkillStatus {
  if (tracked) return { skill, state: 'not-owned', path, detail: TRACKED };
  switch (found.kind) {
    case 'absent':
      return { skill, state: 'missing', path };
    case 'link':
    case 'not-owned':
      return { skill, state: 'not-owned', path, detail: blockLabel(found, false) as string };
    case 'edited':
      return { skill, state: 'edited', path };
    case 'unreadable':
      return { skill, state: 'unreadable', path, detail: found.reason };
    case 'unmarked-copy':
      return { skill, state: 'unmarked', path };
    case 'owned':
      return { skill, state: found.sha256 === sourceHash ? 'in-step' : 'drifted', path };
  }
}

/**
 * Compares each approved skill with its copy at the project top, finds
 * each owned folder that is no longer approved, and lists leftover temp
 * folders and exclude-file notes. It changes nothing.
 */
export async function checkSkills(ctx: Pick<ExportContext, 'env' | 'runner'>, root = packageRoot()): Promise<SkillCheck> {
  try {
    const surveyed = await survey(ctx, root);
    if (!surveyed.ok) return surveyed;
    const plan = surveyed.survey;
    const skills = plan.targets.map((t) => statusOf(t.skill.name, t.path, t.found, t.sourceHash, t.tracked));
    for (const other of plan.others) {
      const { found } = other;
      if (other.tracked || found.kind === 'edited' || found.kind === 'unreadable') skills.push(statusOf(other.name, other.path, found, '', other.tracked));
      else skills.push({ skill: other.name, state: 'stale', path: other.path });
    }
    const notes: string[] = [];
    const read = await readExclude(plan.top, plan.git);
    if (!read.ok) notes.push(read.message);
    else {
      const known = [...plan.approved.map((s) => s.name), ...plan.others.map((o) => o.name)];
      const parsed = updateExcludeText(read.file.text, { add: [], remove: [], known });
      if (!parsed.ok) notes.push(`the git exclude file ${read.file.path}: ${parsed.message}`);
      else notes.push(...parsed.warnings.map((w) => `${read.file.path}: ${w}`));
    }
    return { ok: true, skills, leftovers: plan.leftovers.removable, strays: plan.leftovers.strays, notes };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

const STATE_WORDS: Record<SkillState, string> = {
  'in-step': 'in step',
  drifted: 'drifted',
  missing: 'missing',
  'not-owned': 'not owned',
  edited: 'edited since export',
  unreadable: 'unreadable',
  unmarked: 'unmarked copy',
  stale: 'stale',
};

function stateLine(s: SkillStatus): string {
  const head = `Skill ${s.skill}: ${STATE_WORDS[s.state]}.`;
  switch (s.state) {
    case 'in-step':
      return head;
    case 'drifted':
      return `${head} The copy at ${s.path} differs from the package source.`;
    case 'missing':
      return `${head} Nothing is at ${s.path}.`;
    case 'not-owned':
      return `${head} ${s.path} is ${s.detail ?? 'a folder trellis-crew does not own'}, so it is left alone.`;
    case 'edited':
      return `${head} The copy at ${s.path} changed after the export, so it is left alone.`;
    case 'unreadable':
      return `${head} ${s.path} could not be read (${s.detail ?? 'no detail'}).`;
    case 'unmarked':
      return `${head} ${s.path} matches the package, so install or update adopts it.`;
    case 'stale':
      return `${head} ${s.path} is a trellis-crew copy of a skill this package no longer ships.`;
  }
}

/** The states that make `update --check` exit 1. */
const FAILING: ReadonlySet<SkillState> = new Set(['drifted', 'missing', 'not-owned', 'edited', 'unreadable', 'stale']);

/** The skill lines for `update --check`. */
export async function skillCheckReport(ctx: Pick<ExportContext, 'env' | 'runner'>, root = packageRoot()): Promise<PluginCheck> {
  const check = await checkSkills(ctx, root);
  if (!check.ok) return { lines: [], errors: [`The skill check failed: ${check.message}`], warnings: [] };
  const failing = check.skills.filter((s) => FAILING.has(s.state));
  return {
    lines: check.skills.map(stateLine),
    errors:
      failing.length === 0
        ? []
        : [`The skill check found ${failing.map((s) => `${s.skill} ${STATE_WORDS[s.state]}`).join(', ')}. See each line above.`],
    warnings: [
      ...check.leftovers.map((path) => `warning: ${path} is a leftover temp folder from an export that did not finish. The next install or update removes it.`),
      ...check.strays.map((path) => `warning: ${path} is named like a trellis-crew temp folder but holds no matching trellis-crew marker, so it is left alone.`),
      ...check.notes.map((note) => `warning: ${note}`),
    ],
  };
}
