import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexExperimentalProblem } from '../experimental.ts';
import { processStartTime, startedOf } from '../runner.ts';
import { readTeamFile, writeTeamFile } from '../store/team-json.ts';
import { execArgsProblem } from './codex-args.ts';
import { checkWorkdirSync, codexChildEnv } from './codex-guard.ts';

/** What the CLI hands the supervisor: the binary, the folder, the team record, and each session's arguments. */
export interface SupervisorJob {
  binary: string;
  cwd: string;
  /** The home folder, which is never a working folder. */
  home: string;
  teamPath: string;
  sessions: { name: string; args: string[] }[];
  /** Never set. The supervisor reads its own pid, so the job file cannot name the wrong one. */
  supervisorPid?: undefined;
}

export interface SupervisorOptions {
  /** This supervisor's own process id, which the team record must name before any child starts. */
  ownPid: number;
  pollMs?: number;
  /** How long to wait for the team record to name this supervisor. */
  waitMs?: number;
  /** Reports a refused child. Unset: standard error and codex-supervisor.log beside the team record. */
  warn?: (line: string) => void;
  /** The environment the experimental Codex flag is read from. Unset: this process's own environment. */
  vars?: Readonly<Record<string, string | undefined>>;
}

/** The default report for a refused child. The CLI starts the supervisor with no terminal, so the log file keeps the line. */
function defaultWarn(teamPath: string): (line: string) => void {
  return (line) => {
    process.stderr.write(`${line}\n`);
    try {
      appendFileSync(join(dirname(teamPath), 'codex-supervisor.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Standard error still has the line.
    }
  };
}

export interface SupervisorHandle {
  /** Ends every child, then the supervisor's work. */
  stop(): void;
  /** Settles when no child runs any more, or when the supervisor gave up waiting. */
  done: Promise<void>;
  /** True when the experimental Codex flag was off, so no child was started. */
  refused: boolean;
}

function recordPid(teamPath: string, name: string, pid: number): void {
  const team = readTeamFile(teamPath);
  if (!team.ok || !team.record) return;
  const entry = team.record.sessions.find((s) => s.name === name);
  if (!entry) return;
  entry.pid = pid;
  const started = startedOf(processStartTime(pid));
  if (started !== undefined) entry.started = started;
  writeTeamFile(teamPath, team.record);
}

function namesMe(teamPath: string, ownPid: number): boolean {
  const team = readTeamFile(teamPath);
  return team.ok && team.record?.supervisor_pid === ownPid;
}

/**
 * The detached Codex supervisor. It waits until team.json names it, so the
 * CLI's own write lands first. Then it starts each `codex exec` child and
 * writes the child's pid into team.json. On stop it ends every child.
 *
 * Gap: how to keep a finished `codex exec` alive is not documented. A
 * child that exits stays exited, and the supervisor ends when none runs.
 * TODO: restart a child once the vendor documents how.
 */
export function runSupervisor(job: SupervisorJob, options: SupervisorOptions): SupervisorHandle {
  const pollMs = options.pollMs ?? 200;
  const waitMs = options.waitMs ?? 10_000;
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const settleWhenEmpty = (): void => {
    if (children.size === 0) finish();
  };

  const warn = options.warn ?? defaultWarn(job.teamPath);
  // Defense in depth: the CLI gates Codex before it starts this process, and the supervisor checks the flag again
  // before it waits, reads a record, or starts any child.
  const experimental = codexExperimentalProblem(options.vars ?? process.env);
  if (experimental !== undefined) {
    warn(`trellis-crew supervisor: refused to start any session: ${experimental}`);
    return { stop() {}, done: Promise.resolve(), refused: true };
  }
  const startAll = (): void => {
    // Every child can write the working folder, so it is checked again here, before any child starts.
    const workdir = checkWorkdirSync(job.cwd, job.home);
    if (workdir !== undefined) {
      warn(`trellis-crew supervisor: refused to start any session: ${workdir}`);
      return finish();
    }
    for (const session of job.sessions) {
      if (stopping) break;
      // Defense in depth: the CLI built these arguments, and the supervisor checks them again before it runs any.
      const problem = execArgsProblem(session.args);
      if (problem !== undefined) {
        warn(`trellis-crew supervisor: ${session.name}: refused, so it was not started: ${problem}`);
        continue;
      }
      const child = spawn(job.binary, session.args, { cwd: job.cwd, stdio: 'ignore', env: codexChildEnv(process.env) });
      child.once('error', () => {
        children.delete(session.name);
        settleWhenEmpty();
      });
      child.once('exit', () => {
        children.delete(session.name);
        settleWhenEmpty();
      });
      if (child.pid !== undefined) {
        children.set(session.name, child);
        recordPid(job.teamPath, session.name, child.pid);
      }
    }
    settleWhenEmpty();
  };

  const started = Date.now();
  const wait = (): void => {
    if (stopping) return finish();
    if (namesMe(job.teamPath, options.ownPid)) return startAll();
    if (Date.now() - started > waitMs) return finish();
    setTimeout(wait, pollMs);
  };
  wait();

  return {
    stop() {
      stopping = true;
      for (const child of children.values()) child.kill('SIGTERM');
      settleWhenEmpty();
    },
    done,
    refused: false,
  };
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const jobPath = process.argv[2];
  if (jobPath === undefined) process.exit(2);
  // With the flag off, this entry point reads nothing: not the job file, not the team path. It writes to
  // standard error only, with no log file, and exits.
  const experimental = codexExperimentalProblem(process.env);
  if (experimental !== undefined) {
    process.stderr.write(`trellis-crew supervisor: refused to start any session: ${experimental}\n`);
    process.exit(2);
  }
  const job = JSON.parse(readFileSync(jobPath, 'utf8')) as SupervisorJob;
  const handle = runSupervisor(job, { ownPid: process.pid });
  process.on('SIGTERM', () => handle.stop());
  process.on('SIGINT', () => handle.stop());
  await handle.done;
  process.exit(0);
}
