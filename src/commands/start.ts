import { rmSync } from 'node:fs';
import { buildLaunchFlags, launchValues } from '../adapters/flags.ts';
import { adapterFor } from '../adapters/index.ts';
import type { Adapter, AdapterContext, LaunchItem, LaunchValues } from '../adapters/types.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { terminalAsk } from '../detect/confirm.ts';
import { codexExperimentalProblem } from '../experimental.ts';
import { printable } from '../printable.ts';
import { findBinary, HARNESSES } from '../detect/probe.ts';
import { composeKickoff } from '../kickoff/compose.ts';
import { ensureMailboxFolder, mailboxPath } from '../mailbox/folder.ts';
import { loadTeam, type LoadOptions, type LoadResult } from '../roles/load.ts';
import type { HarnessId, RolesConfig, Session, Transport } from '../roles/schema.ts';
import { readInstallRecord } from '../store/install-yml.ts';
import { readTeam, teamJsonPath, writeTeam, type TeamEntry, type TeamRecord, type TeamSource } from '../store/team-json.ts';
import { startedOf } from '../runner.ts';
import { resolveTransport } from '../transport.ts';

/**
 * Loads the team, applying the chosen harness's bounds. The harness comes
 * from the roles file when it names one, and from install.yml otherwise.
 */
export function loadForHarness(options: Omit<LoadOptions, 'harness'>, deps: CliDeps): LoadResult {
  const installed = readInstallRecord(deps.env);
  const hint = installed.ok ? installed.record?.harness : undefined;
  const first = loadTeam({ ...options, ...(hint ? { harness: hint } : {}) });
  if (!first.ok || first.config.harness === 'auto' || first.config.harness === hint) return first;
  return loadTeam({ ...options, harness: first.config.harness });
}

export interface StartOptions {
  workers?: number;
  roles?: string;
  yes: boolean;
  /** The harness the team must run on, from `up --harness`. A roles file that names another one is refused. */
  harness?: HarnessId;
  /**
   * The SHA-256 of the roles text that `up` read and checked, or null for
   * the default team. The text that start loads must match it, so a file
   * that changed in between is never launched.
   */
  expectSha256?: string | null;
}

/** The line that refuses a roles file naming another harness than --harness, or undefined when it does not. */
export function harnessMismatch(loaded: Extract<LoadResult, { ok: true }>, harness: HarnessId): string | undefined {
  const named = loaded.config.harness;
  if (named === 'auto' || named === harness) return undefined;
  return `${printable(loaded.source)}: the roles file names the harness ${named}, but --harness is ${harness}. Nothing was started.`;
}

/**
 * The start path: loads the team, confirms a roles file found in this
 * folder, and launches every session. `start` and `up` both run it.
 */
export async function runStart(options: StartOptions, deps: CliDeps): Promise<number> {
  // With Codex recorded and the flag off, stop before a roles file is listed or a question asked.
  // planLaunch keeps the same check as the backstop for a roles file that names Codex.
  const installed = readInstallRecord(deps.env);
  if (installed.ok && installed.record?.harness === 'codex') {
    const experimental = codexExperimentalProblem(deps.env.vars);
    if (experimental !== undefined) {
      deps.err(experimental);
      return EXIT_USAGE;
    }
  }
  const loaded = loadForHarness(
    {
      env: deps.env,
      ...(options.roles === undefined ? {} : { roles: options.roles }),
      ...(options.workers === undefined ? {} : { workers: options.workers }),
    },
    deps,
  );
  if (!loaded.ok) {
    for (const line of loaded.lines) deps.err(line);
    return EXIT_USAGE;
  }
  const mismatch = options.harness === undefined ? undefined : harnessMismatch(loaded, options.harness);
  if (mismatch !== undefined) {
    deps.err(mismatch);
    return EXIT_USAGE;
  }
  if (options.expectSha256 !== undefined && loaded.sha256 !== options.expectSha256) {
    deps.err(`${printable(loaded.source)}: the roles file changed after up read it. Nothing was started.`);
    return EXIT_USAGE;
  }
  if (options.roles === undefined && loaded.file !== null) {
    const stop = await confirmFoundRoles(loaded.file, loaded.config, options.yes, deps);
    if (stop !== undefined) return stop;
  }
  const source = {
    file: loaded.file,
    ...(loaded.sha256 === null ? {} : { sha256: loaded.sha256 }),
    ...(options.workers === undefined ? {} : { workers: options.workers }),
  };
  return (deps.startTeam ?? launchTeam)(loaded.config, deps, source);
}

/**
 * Shows a roles file that `start` found in the current folder, with each
 * session's kickoff, and asks before it starts anything. A cloned folder
 * can hold a roles file with another author's prompts, so it never loads
 * silently. `--yes` skips the question. With no terminal and no `--yes`,
 * it refuses. Returns an exit code to stop with, or undefined to go on.
 */
export async function confirmFoundRoles(
  file: string,
  config: RolesConfig,
  yes: boolean,
  deps: CliDeps,
  wording: RolesConfirmWording = {
    heading: 'Roles file found in this folder',
    question: `Start ${config.sessions.length} sessions from this file? [y/N] `,
    noTerminal: 'No terminal can confirm this roles file. Read it, then run again with --yes, or pass --roles <file>.',
    declined: 'Nothing was started.',
  },
): Promise<number | undefined> {
  showRoles(file, config, wording.heading, deps);
  if (yes) return undefined;
  if (!deps.env.stdinIsTTY) {
    deps.err(wording.noTerminal);
    return EXIT_USAGE;
  }
  const answer = (await (deps.ask ?? terminalAsk())(wording.question)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return undefined;
  deps.err(wording.declined);
  return EXIT_RUNTIME;
}

/** The lines a roles-file confirm prints and asks. */
export interface RolesConfirmWording {
  heading: string;
  question: string;
  noTerminal: string;
  declined: string;
}

/**
 * Prints what a roles file will do: the harness, the transport, the
 * mailbox folder, each task profile, and each session's kickoff and
 * launch values. Every value is escaped, so a control character cannot
 * hide text.
 */
function showRoles(file: string, config: RolesConfig, heading: string, deps: CliDeps): void {
  deps.out(`${heading}: ${printable(file)}`);
  deps.out(`harness: ${config.harness}`);
  deps.out(`transport: ${config.transport}`);
  // The path that planLaunch uses, at start and at respawn.
  const mailbox = mailboxPath(config, deps.env);
  deps.out(`mailbox: ${printable(mailbox)}${config.mailbox === undefined ? ' (the default)' : ''}`);
  for (const [name, profile] of Object.entries(config.task_profiles)) {
    const parts = [profile.model === undefined ? '' : `model ${profile.model}`, profile.effort === undefined ? '' : `effort ${profile.effort}`];
    deps.out(printable(`task profile ${name}: ${parts.filter((p) => p !== '').join(', ')}`));
  }
  for (const session of config.sessions) {
    deps.out(`${printable(session.name)}:`);
    for (const line of session.kickoff.trimEnd().split('\n')) deps.out(`  ${printable(line)}`);
    if (session.model !== undefined) deps.out(`  model: ${printable(session.model)}`);
    if (session.effort !== undefined) deps.out(`  effort: ${printable(session.effort)}`);
    if (session.autocompact !== undefined) deps.out(`  autocompact: ${printable(session.autocompact)}`);
  }
}

export interface LaunchPlan {
  harness: HarnessId;
  adapter: Adapter;
  binaryPath: string;
  transport: Transport;
  mailbox?: string;
}

/** Settles the harness, adapter, binary, transport, and mailbox for a team. Prints why when it cannot. */
export function planLaunch(config: RolesConfig, deps: CliDeps): { ok: true; plan: LaunchPlan } | { ok: false; code: number } {
  const installed = readInstallRecord(deps.env);
  if (!installed.ok) {
    deps.err(installed.message);
    return { ok: false, code: EXIT_RUNTIME };
  }
  const harness = config.harness !== 'auto' ? config.harness : installed.record?.harness;
  if (harness === undefined) {
    deps.err('No harness is chosen yet. Run trellis-crew install first.');
    return { ok: false, code: EXIT_RUNTIME };
  }
  // Codex is behind an experimental flag in this version. start and respawn both plan here, before anything is stopped or started.
  if (harness === 'codex') {
    const experimental = codexExperimentalProblem(deps.env.vars);
    if (experimental !== undefined) {
      deps.err(experimental);
      return { ok: false, code: EXIT_USAGE };
    }
  }
  const info = HARNESSES.find((h) => h.id === harness);
  const adapter = adapterFor(harness, deps.adapters);
  if (!info || !adapter) {
    deps.err(`Starting sessions on ${info?.displayName ?? harness} is not built yet.`);
    return { ok: false, code: EXIT_RUNTIME };
  }
  const binaryPath = findBinary(info.binary, deps.env.path);
  if (binaryPath === undefined) {
    deps.err(`${info.displayName} is not on PATH: no ${info.binary} binary was found.`);
    return { ok: false, code: EXIT_RUNTIME };
  }
  const stored = installed.record?.harness === harness ? installed.record.transport : undefined;
  const transport = config.transport !== 'auto' ? config.transport : (stored ?? resolveTransport('auto', info.tier, {}));
  if (transport === 'native' && info.tier !== 1) {
    deps.err(`${info.displayName} has no native peer messaging. Set transport to auto or file-mailbox.`);
    return { ok: false, code: EXIT_USAGE };
  }
  const plan: LaunchPlan = { harness, adapter, binaryPath, transport };
  if (transport === 'file-mailbox') {
    const problem = adapter.mailboxProblem?.(mailboxPath(config, deps.env), deps.env);
    if (problem !== undefined) {
      deps.err(problem);
      return { ok: false, code: EXIT_USAGE };
    }
    const folder = ensureMailboxFolder(mailboxPath(config, deps.env));
    if (!folder.ok) {
      deps.err(folder.message);
      return { ok: false, code: EXIT_RUNTIME };
    }
    plan.mailbox = folder.path;
  }
  return { ok: true, plan };
}

/** Builds one session's flags and kickoff, and prints its warnings. */
export function prepareSession(
  config: RolesConfig,
  session: Session,
  plan: LaunchPlan,
  deps: CliDeps,
  overrides: LaunchValues = {},
): LaunchItem {
  const { args, warnings } = buildLaunchFlags(session.name, launchValues(session, overrides), plan.adapter);
  for (const warning of warnings) deps.err(warning);
  const kickoff = composeKickoff(config, session, {
    harness: plan.harness,
    transport: plan.transport,
    ...(plan.mailbox === undefined ? {} : { mailboxPath: plan.mailbox }),
  });
  return { name: session.name, kickoff, flagArgs: args };
}

function contextFor(plan: LaunchPlan, deps: CliDeps): AdapterContext {
  return {
    env: deps.env,
    runner: deps.runner,
    binaryPath: plan.binaryPath,
    out: deps.out,
    ...(plan.mailbox === undefined ? {} : { mailbox: plan.mailbox }),
  };
}

/** Starts one session and prints its warnings. */
export async function launchSession(
  config: RolesConfig,
  session: Session,
  plan: LaunchPlan,
  deps: CliDeps,
  overrides: LaunchValues = {},
): Promise<{ ok: true; entry: TeamEntry } | { ok: false; message: string }> {
  const item = prepareSession(config, session, plan, deps, overrides);
  const outcome = await plan.adapter.launch(item.name, item.kickoff, item.flagArgs, contextFor(plan, deps));
  if (outcome.ok && outcome.entry.pid !== null) {
    const started = startedOf(deps.runner.startTime(outcome.entry.pid));
    if (started !== undefined) outcome.entry.started = started;
  }
  return outcome;
}

function describeEntry(entry: TeamEntry): string {
  const parts = [entry.pid === null ? undefined : `pid ${entry.pid}`, entry.session_id === null ? undefined : `session ${entry.session_id}`];
  const known = parts.filter((p) => p !== undefined);
  return known.length === 0 ? '' : ` (${known.join(', ')})`;
}

/** Starts every session of a validated team and records each one in team.json. */
export async function launchTeam(config: RolesConfig, deps: CliDeps, source: TeamSource): Promise<number> {
  const existing = readTeam(deps.env);
  if (!existing.ok) {
    deps.err(existing.message);
    return EXIT_RUNTIME;
  }
  if (existing.record) {
    deps.err(`A team record already exists at ${teamJsonPath(deps.env)}. Run trellis-crew stop first.`);
    return EXIT_RUNTIME;
  }
  const planned = planLaunch(config, deps);
  if (!planned.ok) return planned.code;
  const { plan } = planned;

  const record: TeamRecord = { version: 1, harness: plan.harness, transport: plan.transport, roles: source, sessions: [] };
  if (plan.mailbox !== undefined) record.mailbox = plan.mailbox;
  if (plan.adapter.launchAll !== undefined) return launchSupervised(config, plan, record, deps);
  for (const session of config.sessions) {
    const outcome = await launchSession(config, session, plan, deps);
    if (!outcome.ok) {
      writeTeam(deps.env, record);
      deps.err(`${session.name}: could not start: ${outcome.message}`);
      deps.err(
        `Started ${record.sessions.length} of ${config.sessions.length} sessions. Run trellis-crew stop to end the ones that started.`,
      );
      return EXIT_RUNTIME;
    }
    record.sessions.push(outcome.entry);
    writeTeam(deps.env, record);
    deps.out(`Started ${session.name}${describeEntry(outcome.entry)}.`);
  }
  deps.out(`Started ${record.sessions.length} sessions on ${plan.adapter.displayName}. Team record: ${teamJsonPath(deps.env)}`);
  return EXIT_OK;
}

/**
 * Hands the whole team to the adapter's detached supervisor. team.json is
 * written first with no pids, then again with the supervisor's pid. The
 * supervisor starts no child until the record names it, so its pid writes
 * never race the CLI's writes.
 */
async function launchSupervised(config: RolesConfig, plan: LaunchPlan, record: TeamRecord, deps: CliDeps): Promise<number> {
  const items = config.sessions.map((session) => prepareSession(config, session, plan, deps));
  record.sessions = items.map((item) => ({ name: item.name, pid: null, session_id: null }));
  writeTeam(deps.env, record);
  const outcome = (await plan.adapter.launchAll?.(items, contextFor(plan, deps), teamJsonPath(deps.env))) ?? {
    ok: false as const,
    message: `${plan.adapter.displayName} has no supervisor`,
  };
  if (!outcome.ok) {
    rmSync(teamJsonPath(deps.env), { force: true });
    deps.err(`The supervisor could not start: ${outcome.message}`);
    return EXIT_RUNTIME;
  }
  record.supervisor_pid = outcome.supervisorPid;
  const started = startedOf(deps.runner.startTime(outcome.supervisorPid));
  if (started !== undefined) record.supervisor_started = started;
  writeTeam(deps.env, record);
  deps.out(
    `Started the supervisor (pid ${outcome.supervisorPid}). It starts ${items.length} sessions on ${plan.adapter.displayName} and records each pid.`,
  );
  deps.out(`Team record: ${teamJsonPath(deps.env)}`);
  return EXIT_OK;
}
