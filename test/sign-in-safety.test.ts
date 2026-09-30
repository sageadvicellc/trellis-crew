import fs, { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import type { FetchLatest } from '../src/registry.ts';
import { writeInstallRecord } from '../src/store/install-yml.ts';
import { makeTestEnv } from './helpers/env.ts';
import { makeFixtureRepo } from './helpers/git-repo.ts';
import { recordingRunner, type RecordedCall } from './helpers/recording-runner.ts';
import { repoRoot } from './helpers/paths.ts';

/**
 * Records every call to a node:fs, fs.promises, or node:fs/promises function
 * whose first argument names a Claude credential file. The path may be a
 * string, a Buffer, or a URL. It lets the run-time test prove that no
 * command touches the sentinel files it plants. The wrapper changes nothing
 * else.
 */
const recorder = vi.hoisted(() => {
  const touched: string[] = [];
  const CREDENTIAL_FILE = /(^|\/)(\.credentials\.json|\.claude\.json)$/;
  const asPath = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof URL) return decodeURIComponent(value.pathname);
    return undefined;
  };
  const wrapFunctions = (source: Record<string, unknown>): Record<string, unknown> => {
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'function' && /^[a-z]/.test(key)) {
        const original = value as (...args: unknown[]) => unknown;
        wrapped[key] = Object.assign(
          function (this: unknown, ...args: unknown[]) {
            const path = asPath(args[0]);
            if (path !== undefined && CREDENTIAL_FILE.test(path)) touched.push(`${key}:${path}`);
            return original.apply(this, args);
          },
          original,
        );
      } else {
        wrapped[key] = value;
      }
    }
    return wrapped;
  };
  return { touched, wrapFunctions };
});
const touched = recorder.touched;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapped = recorder.wrapFunctions(actual as unknown as Record<string, unknown>);
  wrapped.promises = recorder.wrapFunctions(actual.promises as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = recorder.wrapFunctions(actual as unknown as Record<string, unknown>);
  return { ...wrapped, default: wrapped };
});

/** A value that is not a real key. The tests check that it is never echoed. */
const FIXTURE_KEY = 'fixture-key-value-9f3c1a';
const SENTINEL = 'sentinel-not-a-real-file';
function rig(vars: Record<string, string | undefined> = {}) {
  const base = makeTestEnv({ cwd: makeFixtureRepo().root });
  const env = { ...base, vars: { ...base.vars, ...vars } };
  mkdirSync(join(env.home, '.claude'));
  writeFileSync(join(env.home, '.claude', 'settings.json'), '{"theme": "dark"}\n');
  const runner = recordingRunner();
  /** Every printed line, in order, tagged with its stream. */
  const log: string[] = [];
  const outLines: string[] = [];
  const errLines: string[] = [];
  const out = (line: string) => {
    log.push(`out:${line}`);
    outLines.push(line);
  };
  const err = (line: string) => {
    log.push(`err:${line}`);
    errLines.push(line);
  };
  const fetchLatest: FetchLatest = async () => ({ status: 'ok', version: '9.9.9' });
  const deps = { env, runner, out, err, ask: vi.fn(async () => 'y'), fetchLatest, now: () => new Date('2026-03-04T10:00:00Z') };
  return { env, runner, log, deps, outText: () => outLines.join('\n'), errText: () => errLines.join('\n') };
}

/** Every file that ships as code: src, root scripts, and the package.json scripts. Tests are not shipped. */
const CODE_EXTENSIONS = /\.(ts|js|mjs|cjs)$/;

function codeFiles(dir: string, top: boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return top ? [] : codeFiles(path, false);
    return CODE_EXTENSIONS.test(name) ? [path] : [];
  });
}

const packageScripts = Object.entries(
  (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {},
).map(([name, script]) => ({ name: `package.json#scripts.${name}`, text: script }));

const files = [
  ...codeFiles(join(repoRoot, 'src'), false),
  ...codeFiles(repoRoot, true),
].map((path) => ({ name: relative(repoRoot, path), text: readFileSync(path, 'utf8') }));
/** The shipped skills are prompts that run inside the user's sessions, so they are scanned too. */
function skillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? skillFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
const skills = skillFiles(join(repoRoot, 'skills')).map((path) => ({ name: relative(repoRoot, path), text: readFileSync(path, 'utf8') }));
const shipped = [...files, ...packageScripts, ...skills];

/** Every line of every shipped file that matches, as `file:line`. */
function hits(pattern: RegExp): string[] {
  return shipped.flatMap((f) => f.text.split('\n').flatMap((line, i) => (pattern.test(line) ? [`${f.name}:${i + 1}`] : [])));
}

const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const CALL = /\b(run|spawn|spawnSync|spawnDetached|execFile|execFileSync|exec|execSync|pluginCommand)\s*\(/g;

/** The text of each call to a process-starting function, from its open parenthesis to its close. */
function callSites(text: string): string[] {
  const sites: string[] = [];
  for (const match of text.matchAll(CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let quote = '';
    let i = open;
    for (; i < text.length; i += 1) {
      const c = text[i] as string;
      if (quote !== '') {
        if (c === '\\') i += 1;
        else if (c === quote) quote = '';
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    sites.push(text.slice(open, i + 1));
  }
  return sites;
}

/** The string literals inside process-starting calls, as `file: literal`. */
function callSiteLiterals(): { where: string; literal: string }[] {
  return shipped.flatMap((f) =>
    callSites(f.text).flatMap((site) => (site.match(STRING_LITERAL) ?? []).map((literal) => ({ where: f.name, literal }))),
  );
}

/*
 * The scan below is a heuristic. It reads text, so it cannot see a string
 * that code builds at run time. It pairs with the runtime check further
 * down, which records every call the CLI makes to any program.
 */
describe('sign-in safety: static scan of shipped code', () => {
  it('scans the source files and the package scripts', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(skills.length).toBeGreaterThanOrEqual(7);
    expect(skills.every((f) => f.name.startsWith('skills/'))).toBe(true);
    expect(packageScripts.length).toBeGreaterThan(3);
    expect(files.some((f) => f.name === 'src/adapters/claude-code.ts')).toBe(true);
  });

  it('the call-site finder sees the calls that start a process', () => {
    const sites = callSites(files.find((f) => f.name === 'src/adapters/claude-code.ts')?.text ?? '');
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(callSites("runner.run('x', ['a', 'b(c'], {})")).toEqual(["('x', ['a', 'b(c'], {})"]);
  });

  it('no literal runs login, logout, auth, or setup-token as a claude subcommand', () => {
    expect(hits(/\bclaude\s+(auth|login|logout|setup-token)\b/i)).toEqual([]);
    expect(hits(/['"`]\/?(auth|login|logout|setup-token)['"`]/)).toEqual([]);
  });

  it('no string in a process call holds login, logout, setup-token, or auth, even as part of a word', () => {
    const bad = callSiteLiterals().filter(({ literal }) => /login|logout|setup-token|auth/i.test(literal));
    expect(bad).toEqual([]);
  });

  it('no process call names security, the macOS keychain tool', () => {
    const bad = callSiteLiterals().filter(({ literal }) => /\bsecurity\b/i.test(literal));
    expect(bad).toEqual([]);
    expect(hits(/['"`](\/usr\/bin\/)?security['"`]/)).toEqual([]);
  });

  it('the claude adapter starts claude only with a fixed first argument', () => {
    const text = files.find((f) => f.name === 'src/adapters/claude-code.ts')?.text ?? '';
    const runs = [...text.matchAll(/runner\.(?:run|spawnDetached)\(/g)];
    const fixed = [...text.matchAll(/runner\.(?:run|spawnDetached)\(\s*ctx\.binaryPath,\s*\[\s*'([^']+)'/g)].map((m) => m[1]);
    // Every call names its first argument by a literal, so no dynamic subcommand can reach claude.
    expect(fixed).toHaveLength(runs.length);
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(fixed)).toEqual(new Set(['--bg', 'plugin']));
    // The plugin helper takes its subcommand from literals at its call sites.
    const helper = [...text.matchAll(/pluginCommand\(ctx,\s*\[\s*'([^']+)'/g)].map((m) => m[1]);
    const helperCalls = [...text.matchAll(/pluginCommand\(/g)].length - 1;
    expect(helper).toHaveLength(helperCalls);
    expect(new Set(helper)).toEqual(new Set(['marketplace', 'install', 'update']));
  });

  it('node:child_process is imported only by the runner, the codex supervisor, and the codex folder check', () => {
    const named = new Set(hits(/child_process/).map((h) => h.split(':')[0]));
    // src/runner.ts starts every process the CLI runs. src/adapters/codex-supervisor.ts is
    // the detached codex process. src/adapters/codex-guard.ts runs git, read only, for the
    // codex working-folder check.
    expect(named).toEqual(new Set(['src/runner.ts', 'src/adapters/codex-supervisor.ts', 'src/adapters/codex-guard.ts']));
  });

  it('the git subcommands in the code are the ones the code makes, and none is a credential command', () => {
    const wanted = new Set(['rev-parse', 'config', 'rev-list', 'ls-files', 'diff', 'log', 'diff-tree', 'cat-file']);
    const found = new Set<string>();
    for (const name of ['src/sanitize/run.ts', 'src/adapters/codex-guard.ts']) {
      const text = files.find((f) => f.name === name)?.text ?? '';
      for (const m of text.matchAll(/\[\s*'([a-z][a-z-]*)'/g)) found.add(m[1] as string);
    }
    // Array literals in those files that are not git arguments: config key parts, and shell and node names.
    const notGit = new Set(['vars', 'subsection', 'sh', 'node', 'ignore']);
    expect([...found].filter((word) => !wanted.has(word) && !notGit.has(word))).toEqual([]);
    expect(found.has('credential')).toBe(false);
  });

  it('no reference to a Claude credential store or a credential helper', () => {
    const stores = [
      '\\.credentials\\.json',
      '\\.claude\\.json',
      '/usr/bin/security',
      'find-generic-password',
      'Claude Code-credentials',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'apiKeyHelper',
    ];
    for (const store of stores) expect(hits(new RegExp(store))).toEqual([]);
    // The word credential appears in three places, and none of them runs or reads one:
    // the sanitizer's detail text for a password in a URL, the codex folder check that
    // refuses a git config which names a credential helper, and the auditor skill's
    // instruction to redact one. No process call holds the word.
    const named = new Set(hits(/credential/i).map((h) => h.split(':')[0]));
    expect(named).toEqual(new Set(['src/sanitize/checks.ts', 'src/adapters/codex-guard.ts', 'skills/department-auditor/SKILL.md']));
    expect(callSiteLiterals().filter(({ literal }) => /credential/i.test(literal))).toEqual([]);
  });

  it('no file in src names ANTHROPIC_API_KEY or any other sign-in variable', () => {
    // Trellis neither requires, warns about, nor reads any key. The user signs in to the harness first.
    expect(hits(/ANTHROPIC_/)).toEqual([]);
    expect(hits(/CLAUDE_CODE_USE_/)).toEqual([]);
    expect(files.some((f) => f.name === 'src/sign-in.ts')).toBe(false);
  });
});

describe('sign-in safety: run time', () => {
  const ALLOWED_PROGRAMS = new Set(['claude', 'git']);
  const LAUNCH_FLAGS = new Set(['--autocompact', '--model', '--effort']);
  const PLUGIN_SUBCOMMANDS = new Set(['marketplace', 'install', 'update']);

  /** `--bg --name <n> [--flag value]... -- <kickoff>`, or `plugin marketplace add <repo>`, or `plugin install|update <id>`. */
  function claudeShapeProblem(args: readonly string[]): string | undefined {
    if (args[0] === '--bg') {
      if (args[1] !== '--name') return 'no --name after --bg';
      if ((args[2] ?? '-').startsWith('-')) return 'no session name';
      const end = args.indexOf('--', 3);
      if (end !== args.length - 2) return 'the kickoff is not the one argument after --';
      for (let i = 3; i < end; i += 2) {
        if (!LAUNCH_FLAGS.has(args[i] ?? '')) return `unknown launch flag ${args[i] ?? ''}`;
        if (args[i + 1] === undefined || i + 1 >= end) return 'a launch flag has no value';
      }
      return undefined;
    }
    if (args[0] === 'plugin' && PLUGIN_SUBCOMMANDS.has(args[1] ?? '')) {
      if (args[1] === 'marketplace') return args[2] === 'add' && args.length === 4 ? undefined : 'marketplace takes add <repo> only';
      return args.length === 3 ? undefined : 'plugin install and update take one plugin id';
    }
    return `first argument ${args[0] ?? '(none)'} is not allowed`;
  }

  /**
   * The git calls the CLI makes, found by reading the runner call sites in
   * src/adapters/codex-guard.ts (GIT_TOP and GIT_CONFIG), and nothing else.
   * The sanitizer's own git calls run from npm run sanitize, never from a
   * trellis-crew command, so they are not in this list.
   */
  const CLI_GIT_CALLS = [
    ['rev-parse', '--show-toplevel'],
    ['config', '--list', '--show-origin', '--includes', '-z'],
  ];

  function gitShapeProblem(args: readonly string[]): string | undefined {
    const known = CLI_GIT_CALLS.some((call) => call.length === args.length && call.every((arg, i) => arg === args[i]));
    return known ? undefined : `git ${args.join(' ')} is not a call the CLI makes`;
  }

  function expectOnlyAllowedCalls(calls: readonly RecordedCall[]): void {
    const runs = calls.filter((c) => c.kind !== 'kill');
    expect(runs.every((c) => c.kind === 'run')).toBe(true);
    for (const call of runs) {
      expect(ALLOWED_PROGRAMS.has(basename(call.command))).toBe(true);
      expect(basename(call.command)).not.toBe('security');
    }
    for (const call of runs.filter((c) => basename(c.command) === 'git')) expect(gitShapeProblem(call.args)).toBeUndefined();
    const claudeCalls = runs.filter((c) => basename(c.command) === 'claude');
    expect(claudeCalls.length).toBeGreaterThan(0);
    for (const call of claudeCalls) expect(claudeShapeProblem(call.args)).toBeUndefined();
  }

  const COMMANDS: string[][] = [
    ['install', '--harness', 'claude-code', '--non-interactive', '--skip-inbound'],
    ['start', '--yes'],
    ['status'],
    ['respawn', 'main', '--yes', '--force-stop'],
    ['stop', '--force-stop'],
    ['update', '--check'],
    ['update'],
    ['up', '--harness', 'claude-code', '--skip-inbound'],
    ['stop', '--force-stop'],
  ];

  it('the shape check refuses what it should', () => {
    expect(claudeShapeProblem(['login'])).toBeDefined();
    expect(claudeShapeProblem(['auth', 'login'])).toBeDefined();
    expect(claudeShapeProblem(['setup-token'])).toBeDefined();
    expect(claudeShapeProblem(['plugin', 'login'])).toBeDefined();
    expect(claudeShapeProblem(['--bg', '--name', 'a', '--', 'k', 'login'])).toBeDefined();
    expect(claudeShapeProblem(['--bg', '--name', 'a', '--', 'kickoff'])).toBeUndefined();
    expect(claudeShapeProblem(['--bg', '--name', 'a', '--model', 'm', '--', 'kickoff'])).toBeUndefined();
    expect(claudeShapeProblem(['plugin', 'marketplace', 'add', 'owner/repo'])).toBeUndefined();
  });

  it('the git shape check refuses credential helpers and any other git call', () => {
    expect(gitShapeProblem(['credential', 'fill'])).toBeDefined();
    expect(gitShapeProblem(['credential-osxkeychain', 'get'])).toBeDefined();
    expect(gitShapeProblem(['config', 'credential.helper'])).toBeDefined();
    expect(gitShapeProblem(['config', '--list', '--show-origin', '--includes', '-z', 'credential.helper'])).toBeDefined();
    expect(gitShapeProblem(['rev-parse', '--show-toplevel'])).toBeUndefined();
    expect(gitShapeProblem(['config', '--list', '--show-origin', '--includes', '-z'])).toBeUndefined();
  });

  it('up on codex makes only the two git calls the code makes', async () => {
    const t = rig();
    await main(['up', '--harness', 'codex'], t.deps);
    const gits = t.runner.calls.filter((c) => basename(c.command) === 'git');
    expect(gits.length).toBeGreaterThan(0);
    for (const call of gits) expect(gitShapeProblem(call.args)).toBeUndefined();
    for (const call of t.runner.calls.filter((c) => c.kind === 'run')) expect(basename(call.command)).toBe('git');
  });

  it('install, start, status, respawn, stop, update, and up on claude-code call only allowed programs, in allowed shapes', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    for (const argv of COMMANDS) await main(argv, t.deps);
    expectOnlyAllowedCalls(t.runner.calls);
    const claudeArgs = t.runner.calls.filter((c) => basename(c.command) === 'claude').map((c) => c.args[0]);
    expect(claudeArgs).toContain('--bg');
    expect(claudeArgs).toContain('plugin');
  });

  it('none of those commands touches a Claude credentials file, which the fixture home holds as sentinels', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    const credentials = join(t.env.home, '.claude', '.credentials.json');
    const config = join(t.env.home, '.claude.json');
    writeFileSync(credentials, SENTINEL);
    writeFileSync(config, SENTINEL);
    touched.length = 0;
    // A control: the recorder sees a read of a sentinel, so silence below means something.
    readFileSync(credentials, 'utf8');
    touched.length = 0;
    // The same control through every API and every path type: string, Buffer, and URL.
    const paths = [credentials, Buffer.from(credentials), pathToFileURL(credentials)];
    for (const path of paths) readFileSync(path, 'utf8');
    for (const path of paths) await readFile(path, 'utf8');
    for (const path of paths) await fs.promises.readFile(path, 'utf8');
    expect(touched).toEqual([
      ...paths.map(() => `readFileSync:${credentials}`),
      ...paths.map(() => `readFile:${credentials}`),
      ...paths.map(() => `readFile:${credentials}`),
    ]);
    touched.length = 0;
    for (const argv of COMMANDS) await main(argv, t.deps);
    expect(touched).toEqual([]);
    expect(readFileSync(credentials, 'utf8')).toBe(SENTINEL);
    expect(readFileSync(config, 'utf8')).toBe(SENTINEL);
  });

  it('no output or argument carries the key value', async () => {
    const t = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    for (const argv of COMMANDS) await main(argv, t.deps);
    expect(t.log.join('\n')).not.toContain(FIXTURE_KEY);
    for (const call of t.runner.calls) expect(call.args.join(' ')).not.toContain(FIXTURE_KEY);
  });

  it('a run with no sentinel creates no credentials file', async () => {
    const t = rig();
    for (const argv of COMMANDS) await main(argv, t.deps);
    expect(existsSync(join(t.env.home, '.claude.json'))).toBe(false);
    expect(existsSync(join(t.env.home, '.claude', '.credentials.json'))).toBe(false);
  });
});

describe('up and start print no API key warning', () => {
  const UP = ['up', '--harness', 'claude-code', '--skip-inbound'];
  const KEY_TEXT = /ANTHROPIC|API key|warning/i;
  const cases: [string, Record<string, string | undefined>][] = [
    ['unset', {}],
    ['empty', { ANTHROPIC_API_KEY: '' }],
    ['white space', { ANTHROPIC_API_KEY: '  ' }],
    ['set', { ANTHROPIC_API_KEY: FIXTURE_KEY }],
  ];

  it('up on claude-code prints nothing about a key, whether the key is unset, empty, or set', async () => {
    for (const [, vars] of cases) {
      const t = rig(vars);
      expect(await main(UP, t.deps)).toBe(0);
      expect(t.log.join('\n')).not.toMatch(KEY_TEXT);
      expect(t.log.join('\n')).not.toContain(FIXTURE_KEY);
    }
  });

  it('start on claude-code prints nothing about a key, whether the key is unset, empty, or set', async () => {
    for (const [, vars] of cases) {
      const t = rig(vars);
      writeInstallRecord(t.env, { harness: 'claude-code', transport: 'native', plugin_version: null });
      expect(await main(['start', '--yes'], t.deps)).toBe(0);
      expect(t.log.join('\n')).not.toMatch(KEY_TEXT);
      expect(t.log.join('\n')).not.toContain(FIXTURE_KEY);
    }
  });

  it('up needs no key: the exit code is the same with the key set and unset on the same failing input', async () => {
    const unset = rig();
    const set = rig({ ANTHROPIC_API_KEY: FIXTURE_KEY });
    expect(await main(['up', '--harness', 'claude-code'], unset.deps)).toBe(1);
    expect(await main(['up', '--harness', 'claude-code'], set.deps)).toBe(1);
    expect(unset.log.join('\n')).not.toMatch(/ANTHROPIC|API key/i);
  });
});
