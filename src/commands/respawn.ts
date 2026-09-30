import type { LaunchValues } from '../adapters/types.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { codexExperimentalProblem } from '../experimental.ts';
import {
  CLAUDE_AUTOCOMPACT_MAX,
  CLAUDE_AUTOCOMPACT_MIN,
  CLAUDE_EFFORTS,
  EFFORT_PATTERN,
  MODEL_PATTERN,
  parseAutocompact,
  type HarnessId,
} from '../roles/schema.ts';
import { readTeam, writeTeam } from '../store/team-json.ts';
import { confirmFoundRoles, launchSession, loadForHarness, planLaunch } from './start.ts';
import { noProcessLine, printStop, stopPid } from './stop.ts';

export interface RespawnOptions {
  session: string;
  model?: string;
  effort?: string;
  autocompact?: string;
  /** --yes: use a roles file that changed since start with no question. */
  yes?: boolean;
  /** --force-stop: signal an old pid whose record holds no start time. */
  forceStop?: boolean;
}

/** Checks the flag values against the harness's bounds. Returns the problems found. */
export function checkRespawnFlags(options: RespawnOptions, harness: HarnessId): string[] {
  const problems: string[] = [];
  if (options.model !== undefined) {
    if (options.model.trim() === '') problems.push('--model needs a model name');
    else if (!MODEL_PATTERN.test(options.model)) {
      problems.push('--model must start with a letter or digit, use only letters, digits, and . _ : / @ [ ] -, and be at most 128 characters');
    }
  }
  if (options.autocompact !== undefined) {
    const parsed = parseAutocompact(options.autocompact);
    if (!parsed.ok) {
      problems.push(`--autocompact must be auto or a token count such as 400k, not "${options.autocompact}"`);
    } else if (
      harness === 'claude-code' &&
      parsed.tokens !== 'auto' &&
      (parsed.tokens < CLAUDE_AUTOCOMPACT_MIN || parsed.tokens > CLAUDE_AUTOCOMPACT_MAX)
    ) {
      problems.push(`--autocompact on Claude Code must be auto or 100k to 1M, not ${options.autocompact}`);
    }
  }
  if (options.effort !== undefined) {
    if (options.effort.trim() === '') problems.push('--effort needs a level');
    else if (!EFFORT_PATTERN.test(options.effort)) problems.push('--effort must start with a letter or digit and use only letters, digits, _ and -');
    else if (harness === 'claude-code' && !(CLAUDE_EFFORTS as readonly string[]).includes(options.effort)) {
      problems.push(`--effort on Claude Code must be one of ${CLAUDE_EFFORTS.join(', ')}, not "${options.effort}"`);
    }
  }
  return problems;
}

/**
 * Stops one session the CLI started and starts it again under the same
 * name with the given flags. A flag not given keeps its roles-file value.
 * Every check runs before anything stops. The roles file never changes.
 */
export async function runRespawn(options: RespawnOptions, deps: CliDeps): Promise<number> {
  const team = readTeam(deps.env);
  if (!team.ok) {
    deps.err(team.message);
    return EXIT_RUNTIME;
  }
  if (!team.record) {
    deps.err('No team is running. Run trellis-crew start first.');
    return EXIT_RUNTIME;
  }
  const record = team.record;
  // A team recorded on Codex is refused first, before any roles file is read or any question asked.
  // planLaunch keeps the same check as the backstop.
  if (record.harness === 'codex') {
    const experimental = codexExperimentalProblem(deps.env.vars);
    if (experimental !== undefined) {
      deps.err(experimental);
      return EXIT_USAGE;
    }
  }
  const index = record.sessions.findIndex((s) => s.name === options.session);
  const entry = record.sessions[index];
  if (entry === undefined) {
    deps.err(`No session named "${options.session}" is in the team. Sessions: ${record.sessions.map((s) => s.name).join(', ')}.`);
    return EXIT_USAGE;
  }
  const problems = checkRespawnFlags(options, record.harness);
  if (problems.length > 0) {
    for (const problem of problems) deps.err(problem);
    deps.err('Nothing was stopped.');
    return EXIT_USAGE;
  }

  const source = record.roles ?? { file: null };
  const loaded = loadForHarness(
    {
      env: deps.env,
      ...(source.file === null ? {} : { roles: source.file }),
      ...(source.workers === undefined ? {} : { workers: source.workers }),
    },
    deps,
  );
  if (!loaded.ok) {
    for (const line of loaded.lines) deps.err(line);
    return EXIT_USAGE;
  }
  const config = { ...loaded.config, harness: record.harness, transport: record.transport ?? loaded.config.transport };
  const session = config.sessions.find((s) => s.name === options.session);
  if (session === undefined) {
    deps.err(`The roles file no longer holds a session named "${options.session}". Nothing was stopped.`);
    return EXIT_USAGE;
  }
  // The file may have changed since the operator confirmed it at start. A
  // changed file is shown and confirmed again before anything stops.
  const changed = loaded.file !== null && loaded.sha256 !== source.sha256;
  if (changed && loaded.file !== null) {
    const stop = await confirmFoundRoles(loaded.file, config, options.yes === true, deps, {
      heading: 'The roles file changed since start',
      question: `Respawn ${options.session} from the changed file? [y/N] `,
      noTerminal: 'No terminal can confirm the changed roles file. Read it, then run respawn again with --yes.',
      declined: 'Nothing was stopped or started.',
    });
    if (stop !== undefined) return stop;
  }
  const planned = planLaunch(config, deps);
  if (!planned.ok) return planned.code;
  if (entry.pid === null) {
    deps.err(`cannot stop ${entry.name}: ${noProcessLine(record.harness, entry, deps)}`);
    deps.err('Nothing was stopped or started.');
    return EXIT_RUNTIME;
  }

  const stopped = await stopPid(entry.name, entry.pid, entry.started, deps, options.forceStop ? { forceStop: true } : {});
  printStop(stopped, deps);
  if (stopped.kept) {
    deps.err('Nothing was started, because the old process could not be checked.');
    return EXIT_RUNTIME;
  }
  const overrides: LaunchValues = {};
  if (options.autocompact !== undefined) overrides.autocompact = options.autocompact;
  if (options.model !== undefined) overrides.model = options.model;
  if (options.effort !== undefined) overrides.effort = options.effort;
  const outcome = await launchSession(config, session, planned.plan, deps, overrides);
  if (!outcome.ok) {
    record.sessions.splice(index, 1);
    writeTeam(deps.env, record);
    deps.err(`${entry.name}: could not start again: ${outcome.message}. It is removed from the team record.`);
    return EXIT_RUNTIME;
  }
  record.sessions[index] = outcome.entry;
  // The confirmed file is the new baseline for the next respawn.
  if (changed && loaded.sha256 !== null) record.roles = { ...source, sha256: loaded.sha256 };
  writeTeam(deps.env, record);
  const pid = outcome.entry.pid === null ? '' : ` (pid ${outcome.entry.pid})`;
  deps.out(`Started ${entry.name} again${pid}. The new flags last until the next respawn or stop.`);
  return EXIT_OK;
}
