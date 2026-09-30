import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { findBinary } from '../detect/probe.ts';
import { stateDir, type Env } from '../env.ts';
import { printable } from '../printable.ts';
import type { Runner } from '../runner.ts';

/**
 * The guards for a Codex CLI session. workspace-write lets a session write
 * its working folder and its writable roots. So the working folder must be
 * the top of a git worktree, the one writable root must be a mailbox inside
 * the state folder, and each session gets a short list of environment
 * variables.
 */

const WORKDIR_RULE = 'Codex CLI sessions can write their working folder, so trellis-crew starts them only at the top of a git worktree.';
const GIT_TIMEOUT_MS = 10_000;

/** The git calls the check makes, in the working folder. */
const GIT_TOP = ['rev-parse', '--show-toplevel'];
const GIT_CONFIG = ['config', '--list', '--show-origin', '--includes', '-z'];

/**
 * The environment for every git call the check makes: every GIT_ variable
 * is removed, so git sees what plain git sees. The skill export in
 * codex-skills.ts uses it too.
 */
export function withoutGitVars(vars: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined && !key.startsWith('GIT_')) out[key] = value;
  }
  return out;
}

/** One git answer: the exit code, or null when git could not run, with its output. */
interface GitAnswer {
  code: number | null;
  stdout: string;
  /** The first line of standard error, or why git could not run. */
  reason: string;
}

type Git = (args: readonly string[]) => GitAnswer;

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Judges a working folder. It must be the top of a git worktree, compared
 * after realpath, and not `/` or the home folder. It must hold no other
 * repository at depth 1 to 3. Git must read no config file from inside
 * it, and its hooks folder and fsmonitor command must not sit inside it.
 * The folder's own `.git` is allowed: Codex keeps it read-only.
 */
function workdirProblem(folder: string, home: string, git: Git): string | undefined {
  const why = (reason: string) => `${WORKDIR_RULE} ${printable(folder)}: ${reason}.`;
  const realFolder = real(folder);
  if (realFolder === undefined) return why('the folder cannot be read');
  if (realFolder === sep) return why('it is the root folder');
  if (realFolder === (real(home) ?? resolve(home))) return why('it is your home folder');
  const top = git(GIT_TOP);
  if (top.code !== 0) return why(`it is not in a git worktree (${top.reason || `git exited with code ${String(top.code)}`})`);
  const topPath = firstLine(top.stdout);
  if (real(topPath) !== realFolder) return why(`it is not the top of a git worktree. The top is ${printable(topPath)}`);
  const nested = nestedRepoProblem(realFolder) ?? configProblem(realFolder, home, git(GIT_CONFIG));
  return nested === undefined ? undefined : why(nested);
}

interface ConfigEntry {
  origin: string;
  key: string;
  /** Unset for a key with no value, which git reads as true. */
  value: string | undefined;
}

/**
 * Reads `git config --list --show-origin -z` output. Each entry is the
 * origin, a NUL, the key, then a newline and the value when there is one,
 * and a NUL. Returns undefined when the output does not have that shape.
 */
function parseConfigList(stdout: string): ConfigEntry[] | undefined {
  if (stdout === '') return [];
  if (!stdout.endsWith('\0')) return undefined;
  const tokens = stdout.slice(0, -1).split('\0');
  if (tokens.length % 2 !== 0) return undefined;
  const entries: ConfigEntry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const pair = tokens[i + 1] as string;
    const newline = pair.indexOf('\n');
    entries.push({
      origin: tokens[i] as string,
      key: newline === -1 ? pair : pair.slice(0, newline),
      value: newline === -1 ? undefined : pair.slice(newline + 1),
    });
  }
  return entries;
}

/**
 * Resolves a path from git's config as git does: an absolute path as it
 * is, a leading `~/` against the home folder, and any other path against
 * `base`. Then the realpath of its deepest existing parent is taken. A
 * `~user` form cannot be resolved here, so it returns undefined.
 */
function resolveConfigPath(value: string, base: string, home: string): string | undefined {
  if (value === '~' || value.startsWith('~/')) return realOfExisting(join(home, value.slice(1)));
  if (value.startsWith('~')) return undefined;
  return realOfExisting(isAbsolute(value) ? value : resolve(base, value));
}

/** The values git reads as a boolean. Any other core.fsmonitor value is a command git runs. */
const GIT_BOOLEAN = /^(true|false|yes|no|on|off|1|0)$/i;

/**
 * Refuses git settings that let a session change what git runs, by
 * writing inside the working folder:
 * - a config file that git reads from inside the working folder, outside
 *   its own top-level `.git` folder, either as an entry's origin or as the
 *   target of an include, so an empty include counts too
 * - a `core.hooksPath` that resolves inside the working folder
 * - a command key, such as `core.fsmonitor` or `filter.*.clean`, whose
 *   value names a path inside the working folder (see commandProblem)
 * Relative hooks and fsmonitor paths resolve against the worktree top, and
 * relative include paths against the including file's folder. Every entry
 * is checked, not only the last one. Any git failure refuses, so the check
 * fails closed.
 */
function configProblem(top: string, home: string, answer: GitAnswer): string | undefined {
  const failed = (reason: string) => `git config --list failed, so git's settings cannot be checked (${reason})`;
  if (answer.code !== 0) return failed(answer.reason || `exit code ${String(answer.code)}`);
  const entries = parseConfigList(answer.stdout);
  if (entries === undefined) return failed('its answer cannot be read');
  const ownGit = join(top, '.git');
  const gitFolder = isRealFolder(ownGit) ? realOfExisting(ownGit) : undefined;
  const inside = (path: string) => path === top || within(path, top);
  const exposed = (path: string) => inside(path) && !(gitFolder !== undefined && (path === gitFolder || within(path, gitFolder)));
  const readsFile = (file: string, key: string) =>
    `git reads the config file ${printable(file)}, for the key ${printable(key)}, and that file sits inside the working folder`;
  const otherHome = (key: string, value: string) => `${key} is ${printable(value)}, which names another user's home folder, so it cannot be checked`;

  for (const entry of entries) {
    const file = entry.origin.startsWith('file:') ? realOfExisting(resolve(top, entry.origin.slice('file:'.length))) : undefined;
    if (file !== undefined && exposed(file)) return readsFile(file, entry.key);
    if (file !== undefined && /^include(if\..+)?\.path$/.test(entry.key)) {
      const target = resolveConfigPath(entry.value ?? '', dirname(file), home);
      if (target === undefined) return otherHome(entry.key, entry.value ?? '');
      if (exposed(target)) return readsFile(target, entry.key);
    }
    if (entry.key === 'core.hookspath') {
      const value = entry.value ?? '';
      const resolved = resolveConfigPath(value, top, home);
      if (resolved === undefined) return otherHome('core.hooksPath', value);
      if (inside(resolved)) {
        return `core.hooksPath is ${printable(value)}, which resolves to ${printable(resolved)}, inside the working folder, so a session could write a git hook`;
      }
    }
    const command = commandProblem(entry, top, home);
    if (command !== undefined) return command;
  }
  return undefined;
}

/**
 * A config key pattern: the section, the subsection, and the variable
 * (`*` for any). The subsection is `none`, `any` (one must be there), or
 * `either`. With `bang`, the value counts only when it starts with `!`,
 * which is how git marks a shell command in that key.
 */
interface KeyPattern {
  section: string;
  subsection: 'none' | 'any' | 'either';
  variable: string;
  bang?: true;
}

function pattern(section: string, subsection: KeyPattern['subsection'], variable: string, bang?: 'bang'): KeyPattern {
  return { section, subsection, variable, ...(bang === undefined ? {} : { bang: true as const }) };
}

/** The keys whose value is a command that git runs, often through a shell, with the worktree top as its folder. */
const COMMAND_KEYS: readonly KeyPattern[] = [
  pattern('core', 'none', 'fsmonitor'),
  pattern('core', 'none', 'sshcommand'),
  pattern('core', 'none', 'editor'),
  pattern('core', 'none', 'pager'),
  pattern('core', 'none', 'askpass'),
  pattern('core', 'none', 'gitproxy'),
  pattern('core', 'none', 'alternaterefscommand'),
  pattern('sequence', 'none', 'editor'),
  pattern('alias', 'either', '*', 'bang'),
  pattern('pager', 'none', '*'),
  pattern('filter', 'any', 'clean'),
  pattern('filter', 'any', 'smudge'),
  pattern('filter', 'any', 'process'),
  pattern('diff', 'none', 'external'),
  pattern('diff', 'any', 'textconv'),
  pattern('diff', 'any', 'command'),
  pattern('merge', 'any', 'driver'),
  pattern('difftool', 'any', 'cmd'),
  pattern('mergetool', 'any', 'cmd'),
  pattern('gpg', 'none', 'program'),
  pattern('gpg', 'any', 'program'),
  pattern('gpg', 'any', 'defaultkeycommand'),
  pattern('credential', 'none', 'helper'),
  pattern('credential', 'any', 'helper'),
  pattern('remote', 'any', 'uploadpack'),
  pattern('remote', 'any', 'receivepack'),
  pattern('submodule', 'any', 'update', 'bang'),
  pattern('browser', 'any', 'cmd'),
  pattern('man', 'any', 'cmd'),
  // Git reads send-email settings both plain and under an identity subsection.
  pattern('sendemail', 'either', 'smtpserver'),
  pattern('sendemail', 'either', 'sendmailcmd'),
  pattern('sendemail', 'either', 'tocmd'),
  pattern('sendemail', 'either', 'cccmd'),
  pattern('trailer', 'any', 'command'),
  pattern('trailer', 'any', 'cmd'),
];

/** The shells and runtimes whose next word is the script they run. Python matches with any suffix, such as python3.12. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const RUNTIMES: ReadonlySet<string> = new Set(['node', 'deno', 'bun', 'perl', 'ruby', 'php']);

function isInterpreter(word: string): boolean {
  const name = basename(word);
  return SHELLS.has(name) || RUNTIMES.has(name) || name.startsWith('python');
}

/**
 * Splits a config key into its section, subsection, and variable. Git
 * lowercases the section and the variable, and the subsection keeps its
 * case and may hold dots, as a credential URL does.
 */
function splitKey(key: string): { section: string; subsection: string | null; variable: string } {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1) return { section: key.toLowerCase(), subsection: null, variable: '' };
  return {
    section: key.slice(0, first).toLowerCase(),
    subsection: first === last ? null : key.slice(first + 1, last),
    variable: key.slice(last + 1).toLowerCase(),
  };
}

function commandKeyOf(key: string): KeyPattern | undefined {
  const { section, subsection, variable } = splitKey(key);
  return COMMAND_KEYS.find(
    (p) =>
      p.section === section &&
      (p.subsection === 'either' || (p.subsection === 'none') === (subsection === null)) &&
      (p.variable === '*' || p.variable === variable),
  );
}

/** The characters a shell splits or expands at. The word test splits there too. */
const SHELL_SPLIT = /[\s;&|(){}<>`$"'!]+/;

/**
 * Refuses a command key whose value names a path inside the working
 * folder. The value is split into words at white space and at each shell
 * character. A word with a `/`, or one that starts with `.` or `~`, is a
 * path, which resolves against the worktree top. A word with no `/`, such
 * as `%f` or `git-lfs`, is not a path. This is not a shell parser: a
 * command found on PATH, or a path built at run time, is not seen.
 *
 * Git runs these commands in the worktree top, so an interpreter with a
 * bare script name, such as `sh fsmon.sh`, runs a file a session can
 * write. So each word whose base name is a listed shell or runtime must
 * be followed by an absolute path outside the working folder. An option,
 * such as `sh -c` or `python3 -m`, or no word at all, refuses, which fails
 * closed. Every word is looked at, so `env` and its `VAR=value` words
 * never hide the interpreter after them.
 * - `core.fsmonitor` passes as a boolean, and an empty one is refused.
 * - `alias.*` and `submodule.*.update` count only when they start with `!`.
 */
function commandProblem(entry: ConfigEntry, top: string, home: string): string | undefined {
  const matched = commandKeyOf(entry.key);
  if (matched === undefined || entry.value === undefined) return undefined;
  const { section, variable } = splitKey(entry.key);
  const value = entry.value;
  if (section === 'core' && variable === 'fsmonitor') {
    if (GIT_BOOLEAN.test(value)) return undefined;
    if (value.trim() === '') return `${entry.key} is empty, so it cannot be checked`;
  }
  if (matched.bang === true && !value.startsWith('!')) return undefined;
  const inside = (path: string) => path === top || within(path, top);
  const words = value.split(SHELL_SPLIT).filter((word) => word !== '');
  for (const word of words) {
    if (!(word.includes('/') || word.startsWith('.') || word.startsWith('~'))) continue;
    const resolved = resolveConfigPath(word, top, home);
    if (resolved === undefined) return `${entry.key} is ${printable(value)}, which names another user's home folder, so it cannot be checked`;
    if (inside(resolved)) {
      return `${entry.key} is ${printable(value)}, and the path ${printable(word)} in it resolves to ${printable(resolved)}, inside the working folder, so a session could write the command git runs`;
    }
  }
  for (const [i, word] of words.entries()) {
    if (!isInterpreter(word)) continue;
    const next = words[i + 1];
    if (next !== undefined && isAbsolute(next) && !inside(realOfExisting(next))) continue;
    const after = next === undefined ? 'nothing' : printable(next);
    return `${entry.key} is ${printable(value)}, and the interpreter ${printable(word)} in it has ${after} after it, not an absolute path outside the working folder, so it cannot be checked`;
  }
  return undefined;
}

function isRealFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** How deep below the working folder the scan for other repositories looks. */
const NESTED_DEPTH = 3;

/**
 * Looks for another git repository below a worktree top, breadth first,
 * at depth 1 to NESTED_DEPTH. A folder that holds a `.git` entry of any
 * kind, a folder or a gitfile, counts. The top's own `.git` is not
 * entered. A symbolic link is never followed. A folder that cannot be
 * read is refused, so the scan fails closed. Returns the reason, which
 * names the first path found relative to the top, or undefined.
 */
function nestedRepoProblem(top: string): string | undefined {
  let level = [''];
  for (let depth = 0; depth <= NESTED_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(top, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
        return `a folder below it cannot be read, so it cannot be checked for other git repositories: ${printable(rel || '.')} (${code})`;
      }
      if (depth > 0 && entries.some((entry) => entry.name === '.git')) return `it holds another git repository at ${printable(rel)}`;
      if (depth === NESTED_DEPTH) continue;
      for (const entry of entries) {
        // A Dirent from readdir describes the entry itself, so a link is never a directory here.
        if (!entry.isDirectory() || (depth === 0 && entry.name === '.git')) continue;
        next.push(rel === '' ? entry.name : join(rel, entry.name));
      }
    }
    level = next;
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Checks the Env's current folder through the injected runner. Git is
 * looked up on the Env's PATH, as every binary is. Both git calls run
 * first, in that folder, and then the one judge reads their answers.
 * Returns the reason the folder is refused, or undefined.
 */
export async function checkWorkdir(env: Env, runner: Runner): Promise<string | undefined> {
  const binary = findBinary('git', env.path);
  const answers = new Map<string, GitAnswer>();
  for (const args of [GIT_TOP, GIT_CONFIG]) {
    let answer: GitAnswer = { code: null, stdout: '', reason: 'git is not on PATH' };
    if (binary !== undefined) {
      const result = await runner.run(binary, args, { cwd: env.cwd, env: withoutGitVars(env.vars), timeoutMs: GIT_TIMEOUT_MS });
      answer = result.timedOut
        ? { code: null, stdout: '', reason: 'git did not answer in time' }
        : { code: result.code, stdout: result.stdout, reason: result.error ?? firstLine(result.stderr) };
    }
    answers.set(args.join(' '), answer);
  }
  return workdirProblem(env.cwd, env.home, (args) => answers.get(args.join(' ')) as GitAnswer);
}

/** The same check for the supervisor, which has no runner. It runs git with an argument list and no shell. */
export function checkWorkdirSync(folder: string, home: string): string | undefined {
  return workdirProblem(folder, home, (args) => {
    try {
      const stdout = execFileSync('git', [...args], {
        cwd: folder,
        env: withoutGitVars(process.env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
      });
      return { code: 0, stdout, reason: '' };
    } catch (error) {
      const failed = error as { status?: unknown; stderr?: unknown };
      const reason = firstLine(String(failed.stderr ?? '')) || (error instanceof Error ? error.message : String(error));
      return { code: typeof failed.status === 'number' ? failed.status : null, stdout: '', reason };
    }
  });
}

/** The realpath of a path whose last parts may not exist yet: the realpath of its nearest existing parent, with the rest joined on. */
function realOfExisting(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    const found = real(current);
    if (found !== undefined) return join(found, ...rest.reverse());
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    rest.push(basename(current));
    current = parent;
  }
}

function within(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * Returns why a mailbox folder is refused on Codex CLI, or undefined. The
 * mailbox is every session's writable root, so it must sit inside the
 * state folder, after realpath of its existing parent. It must not be the
 * state folder itself, and it must not hold the working folder.
 */
export function codexMailboxProblem(mailbox: string, env: Pick<Env, 'home' | 'cwd'>): string | undefined {
  const state = stateDir(env);
  const why = (reason: string) =>
    `The file mailbox on Codex CLI must be a folder inside ${printable(state)}, because every session can write it. ${printable(mailbox)}: ${reason}.`;
  const box = realOfExisting(mailbox);
  const realState = realOfExisting(state);
  const cwd = realOfExisting(env.cwd);
  if (box === sep) return why('it is the root folder');
  if (box === realOfExisting(env.home)) return why('it is your home folder');
  if (box === realState) return why('it is the state folder itself');
  if (within(realState, box)) return why('it holds the state folder');
  if (box === cwd || within(cwd, box)) return why('it holds the working folder');
  if (!within(box, realState)) return why('it is outside the state folder');
  return undefined;
}

/** The environment variables a Codex child gets. No other variable, and no other CODEX_ variable, passes. */
export const CODEX_CHILD_ENV: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'OPENAI_API_KEY', 'CODEX_HOME',
];

/** Keeps only the listed variables that are set. */
export function codexChildEnv(vars: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CODEX_CHILD_ENV) {
    const value = vars[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
