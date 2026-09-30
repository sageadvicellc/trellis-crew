import type { Env } from '../env.ts';
import type { InboundTarget } from '../settings/inbound.ts';
import type { HarnessId } from '../roles/schema.ts';
import type { Runner } from '../runner.ts';
import type { TeamEntry } from '../store/team-json.ts';

/** The roles-file fields that become launch flags. */
export type LaunchField = 'autocompact' | 'model' | 'effort';
export const LAUNCH_FIELDS: readonly LaunchField[] = ['autocompact', 'model', 'effort'];

export type LaunchValues = Partial<Record<LaunchField, string>>;

export interface AdapterContext {
  env: Env;
  runner: Runner;
  /** The harness binary found on PATH. */
  binaryPath: string;
  /** Prints one line for the operator. */
  out: (line: string) => void;
  /** The absolute file mailbox folder, for the file-mailbox transport. */
  mailbox?: string;
}

export type LaunchOutcome = { ok: true; entry: TeamEntry } | { ok: false; message: string };

/**
 * The result of a plugin install or update. `skipped` marks a step that a
 * documented gap blocks: the rest of the install still runs.
 */
export type PluginOutcome = { ok: true } | { ok: false; message: string; skipped?: boolean };

/** What `update --check` reports about the installed plugin. Any error line makes it exit 1; a warning does not. */
export interface PluginCheck {
  lines: string[];
  errors: string[];
  warnings: string[];
}

/** What each harness adapter provides. */
export interface Adapter {
  id: HarnessId;
  displayName: string;
  /** The verified flag for each launch field. A field with no flag is ignored with a warning. */
  flags: Partial<Record<LaunchField, string>>;
  /** Starts one named session with its kickoff as the first prompt. */
  launch(name: string, kickoff: string, flagArgs: readonly string[], ctx: AdapterContext): Promise<LaunchOutcome>;
  /** The line stop prints for a recorded session that holds no local process. */
  noProcessNote(entry: TeamEntry): string;
  /** Installs the plugin the way the harness documents. Unset: not built yet. */
  installPlugin?(ctx: AdapterContext): Promise<PluginOutcome>;
  /** Updates the plugin through the harness. Unset: not built yet. */
  updatePlugin?(ctx: AdapterContext): Promise<PluginOutcome>;
  /** Compares the installed plugin with the one this CLI carries, for `update --check`. It changes nothing. */
  checkPlugin?(ctx: Pick<AdapterContext, 'env' | 'runner'>): Promise<PluginCheck>;
  /** The user settings file whose inbound setting install sets to accept, after a dated backup. */
  inboundTarget?(env: Env): InboundTarget;
  /**
   * Why a file mailbox folder is refused on this harness, or undefined.
   * Checked before the folder is created. Unset: any folder the roles file
   * allows.
   */
  mailboxProblem?(mailbox: string, env: Env): string | undefined;
  /** Extra status lines from the harness's own session list. */
  statusLines?(ctx: AdapterContext): Promise<string[]>;
  /**
   * Hands every session to one detached supervisor, on a harness that
   * needs one. The supervisor writes each child's pid into the team record
   * at `teamPath` once that record names the supervisor.
   */
  launchAll?(items: readonly LaunchItem[], ctx: AdapterContext, teamPath: string): Promise<SupervisorOutcome>;
}

/** One session for a supervisor to start. */
export interface LaunchItem {
  name: string;
  kickoff: string;
  flagArgs: readonly string[];
}

export type SupervisorOutcome = { ok: true; supervisorPid: number } | { ok: false; message: string };
