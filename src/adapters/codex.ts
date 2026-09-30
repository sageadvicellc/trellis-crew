import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../env.ts';
import { writeFileAtomic } from '../fs-atomic.ts';
import { ensurePrivateFolder } from '../fs-private.ts';
import { CODEX_FLAGS, codexExecArgs } from './codex-args.ts';
import { checkWorkdir, codexChildEnv, codexMailboxProblem } from './codex-guard.ts';
import { exportSkills, skillCheckReport } from './codex-skills.ts';
import type { SupervisorJob } from './codex-supervisor.ts';
import type { Adapter, AdapterContext, PluginOutcome } from './types.ts';

export { CODEX_FLAGS, codexExecArgs, codexSandboxArgs, execArgsProblem, refusedCodexFlag } from './codex-args.ts';

/** The skill folders this package carries, one per skill. */
export function packageSkillsDir(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

/** The supervisor script beside this file: `.ts` when run from source, `.js` when built. */
export function supervisorScriptPath(): string {
  const ext = extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`./codex-supervisor${ext}`, import.meta.url));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why the working folder or the mailbox is refused for a Codex session, or undefined. */
async function placeProblem(ctx: AdapterContext): Promise<string | undefined> {
  const workdir = await checkWorkdir(ctx.env, ctx.runner);
  if (workdir !== undefined) return workdir;
  return ctx.mailbox === undefined ? undefined : codexMailboxProblem(ctx.mailbox, ctx.env);
}

/** Exports each approved skill into `.agents/skills/<skill>/` at the project's worktree top, never under home. See codex-skills.ts. */
function copySkills(ctx: AdapterContext): Promise<PluginOutcome> {
  return exportSkills(ctx);
}

/**
 * Codex CLI, tier three. Codex documents `codex exec "<prompt>"` and no
 * detach flag, no session-name flag, and no cross-session messaging. So
 * `start` hands every session to one detached supervisor, which starts
 * each `codex exec` process, and the team uses the file mailbox. No launch
 * flag is verified, so every set field warns. Every session runs in the
 * workspace-write sandbox with network access off, and the mailbox folder
 * as its one extra writable root. Every launch flag is refused.
 */
export const codexAdapter: Adapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  flags: CODEX_FLAGS,

  mailboxProblem: codexMailboxProblem,

  /** Starts one session on its own, for respawn. */
  async launch(name, kickoff, flagArgs, ctx) {
    try {
      const args = codexExecArgs(flagArgs, kickoff, ctx.mailbox);
      const refused = await placeProblem(ctx);
      if (refused !== undefined) return { ok: false, message: refused };
      const { pid } = await ctx.runner.spawnDetached(ctx.binaryPath, args, { env: codexChildEnv(ctx.env.vars), cwd: ctx.env.cwd });
      return { ok: true, entry: { name, pid, session_id: null } };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  },

  async launchAll(items, ctx, teamPath) {
    // Every session's arguments are built before the job file is written, so a refused one starts no session.
    const sessions: SupervisorJob['sessions'] = [];
    for (const item of items) {
      try {
        sessions.push({ name: item.name, args: codexExecArgs(item.flagArgs, item.kickoff, ctx.mailbox) });
      } catch (error) {
        return { ok: false, message: `${item.name}: ${errorMessage(error)}` };
      }
    }
    const refused = await placeProblem(ctx);
    if (refused !== undefined) return { ok: false, message: refused };
    const job: SupervisorJob = { binary: ctx.binaryPath, cwd: ctx.env.cwd, home: ctx.env.home, teamPath, sessions };
    const jobPath = join(stateDir(ctx.env), 'codex-supervisor.json');
    try {
      ensurePrivateFolder(stateDir(ctx.env));
      writeFileAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, 0o600);
    } catch (error) {
      return { ok: false, message: `could not write the supervisor job file ${jobPath}: ${errorMessage(error)}` };
    }
    try {
      const { pid } = await ctx.runner.spawnDetached(process.execPath, [supervisorScriptPath(), jobPath], {
        env: ctx.env.vars,
        cwd: ctx.env.cwd,
      });
      return { ok: true, supervisorPid: pid };
    } catch (error) {
      return { ok: false, message: `could not start the supervisor process: ${errorMessage(error)}` };
    }
  },

  noProcessNote(entry) {
    return `${entry.name}: the supervisor recorded no process for it. It never started, it was refused, or the supervisor ended first.`;
  },

  async installPlugin(ctx) {
    return copySkills(ctx);
  },

  async updatePlugin(ctx) {
    // The documented update is a fresh copy of the skill folders.
    return copySkills(ctx);
  },

  checkPlugin(ctx) {
    return skillCheckReport(ctx);
  },
};
