import { claudeInboundTarget } from '../settings/inbound.ts';
import type { Adapter, AdapterContext, PluginOutcome } from './types.ts';

/**
 * The GitHub repository that holds the Claude Code marketplace. A rename
 * is this one line. Per https://code.claude.com/docs/en/plugin-marketplaces,
 * retrieved 2026-09-28, a GitHub-hosted marketplace is added with
 * `claude plugin marketplace add <owner>/<repo>`, and a plugin installs as
 * `<plugin>@<marketplace name>`, where the name is the `name` field of the
 * repository's marketplace.json. The maintainer set that field to the
 * repository's own name, so the name is the part after the slash.
 */
export const CLAUDE_MARKETPLACE_REPO = 'sageadvicellc/sage-freebies';
export const CLAUDE_MARKETPLACE_NAME = CLAUDE_MARKETPLACE_REPO.split('/')[1] as string;
/** The plugin as Claude Code names it: `<plugin>@<marketplace name>`. */
export const CLAUDE_PLUGIN_ID = `trellis-crew@${CLAUDE_MARKETPLACE_NAME}`;

/** How long `claude --bg` may take to return before the launch counts as failed. */
export const CLAUDE_LAUNCH_TIMEOUT_MS = 120_000;
/** How long one `claude plugin` command may take. */
export const CLAUDE_PLUGIN_TIMEOUT_MS = 300_000;

async function pluginCommand(ctx: AdapterContext, args: readonly string[]): Promise<PluginOutcome> {
  // env.vars goes to the user's own claude by design, so the user's own
  // sign-in applies. Trellis never reads, stores, or changes it.
  const result = await ctx.runner.run(ctx.binaryPath, ['plugin', ...args], {
    env: ctx.env.vars,
    cwd: ctx.env.cwd,
    timeoutMs: CLAUDE_PLUGIN_TIMEOUT_MS,
  });
  if (result.code === 0) return { ok: true };
  const reason = result.timedOut
    ? 'it did not finish in time'
    : result.error ?? (result.stderr.trim().split('\n')[0] || `exit code ${String(result.code)}`);
  return { ok: false, message: `claude plugin ${args.join(' ')}: ${reason}` };
}

/**
 * Reads the session id from `claude --bg` output. Gap: the documentation
 * does not state the id's format, so this returns null until a build
 * verifies it. TODO: parse the id once its format is documented.
 */
export function parseBgSessionId(_stdout: string): string | null {
  return null;
}

/**
 * Claude Code, tier one. Each session starts with
 * `claude --bg --name <name> [--autocompact v] [--model m] [--effort e] -- "<kickoff>"`.
 * `--bg` returns at once and cannot be combined with `-p`.
 */
export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  flags: { autocompact: '--autocompact', model: '--model', effort: '--effort' },

  async launch(name, kickoff, flagArgs, ctx) {
    // `--` ends the options, so the kickoff is always the prompt and never an option.
    const result = await ctx.runner.run(ctx.binaryPath, ['--bg', '--name', name, ...flagArgs, '--', kickoff], {
      env: ctx.env.vars,
      cwd: ctx.env.cwd,
      timeoutMs: CLAUDE_LAUNCH_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const reason = result.timedOut
        ? 'claude --bg did not return in time'
        : (result.error ?? result.stderr.trim().split('\n')[0] ?? `exit code ${String(result.code)}`);
      return { ok: false, message: reason || `exit code ${String(result.code)}` };
    }
    // Gap: which process id belongs to a --bg session is not documented, so no pid is recorded.
    return { ok: true, entry: { name, pid: null, session_id: parseBgSessionId(result.stdout) } };
  },

  noProcessNote(entry) {
    return `${entry.name}: Claude Code documents no command that stops a background session, so it still runs. Use the commands that claude --bg printed when it started.`;
  },

  async installPlugin(ctx) {
    // Gap: the docs do not say whether adding a marketplace that is already
    // added succeeds, so a failure here stops the install and prints why.
    const added = await pluginCommand(ctx, ['marketplace', 'add', CLAUDE_MARKETPLACE_REPO]);
    if (!added.ok) return added;
    return pluginCommand(ctx, ['install', CLAUDE_PLUGIN_ID]);
  },

  async updatePlugin(ctx) {
    return pluginCommand(ctx, ['update', CLAUDE_PLUGIN_ID]);
  },

  inboundTarget: claudeInboundTarget,
};
