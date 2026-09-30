import { adapterFor } from '../adapters/index.ts';
import type { TransportFlag } from '../args.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { confirmHarness, terminalAsk } from '../detect/confirm.ts';
import { findBinary, HARNESSES, probeHarnesses, type HarnessInfo } from '../detect/probe.ts';
import { codexExperimentalProblem } from '../experimental.ts';
import { ensureMailboxFolder, mailboxPath } from '../mailbox/folder.ts';
import { loadTeam } from '../roles/load.ts';
import type { RolesConfig, Transport } from '../roles/schema.ts';
import { setInboundAccept, type InboundTarget } from '../settings/inbound.ts';
import { readInstallRecord, writeInstallRecord } from '../store/install-yml.ts';
import { resolveTransport } from '../transport.ts';
import { confirmFoundRoles } from './start.ts';
import { bundledPluginVersion, cliVersion } from '../versions.ts';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface InstallOptions {
  harness?: string;
  nonInteractive: boolean;
  reconfigure: boolean;
  yes?: boolean;
  skipInbound?: boolean;
  transport?: TransportFlag;
  /**
   * The roles file named on the command line, which `up` passes on. It
   * sets the mailbox folder, and it is not confirmed, as start does not
   * confirm a --roles file. Unset: ./sagespec.yml, when it is here.
   */
  roles?: string;
  /** Consent for a roles file found in this folder. Unset: `yes` covers it, as `install --yes` does. */
  rolesYes?: boolean;
  /** The lines that tell the operator how to run again. Unset: the ones that name install. */
  hints?: InstallHints;
  /**
   * Keeps the transport that install.yml records when it names the same
   * harness, and says so. `up` sets it. Unset: `--harness` picks the
   * harness's default transport, as install always has.
   */
  keepStoredTransport?: boolean;
}

/** The lines that name the command and flag to run again with. */
export interface InstallHints {
  /** Printed when nothing consented to the inbound setting. */
  inboundMissing: string;
  /** Printed when no terminal can confirm a roles file found in this folder. */
  rolesNoTerminal: string;
  /** Printed when install.yml cannot be read. */
  recordDamaged: string;
}

const INSTALL_HINTS: InstallHints = {
  inboundMissing: 'Run install again with --yes to set it, or with --skip-inbound to leave it.',
  rolesNoTerminal: 'No terminal can confirm this roles file. Read it, then run install again with --yes.',
  recordDamaged: 'Run trellis-crew install --reconfigure to write it again.',
};

/**
 * The Codex refusal, when install would choose Codex from a flag or from
 * install.yml and the experimental flag is off. It runs before install
 * prints, probes, or asks anything.
 */
function codexRefusal(options: InstallOptions, deps: CliDeps): string | undefined {
  // The variable is read only when Codex is the harness in question, never for another harness.
  // The names the harness look-up accepts for Codex: its id and its display name.
  if (options.harness !== undefined) {
    return ['codex', 'codex cli'].includes(options.harness.trim().toLowerCase()) ? codexExperimentalProblem(deps.env.vars) : undefined;
  }
  if (options.reconfigure) return undefined;
  const stored = readInstallRecord(deps.env);
  return stored.ok && stored.record?.harness === 'codex' ? codexExperimentalProblem(deps.env.vars) : undefined;
}

async function chooseHarness(options: InstallOptions, deps: CliDeps): Promise<{ ok: true; harness: HarnessInfo; stored?: Transport } | { ok: false; code: number }> {
  const early = codexRefusal(options, deps);
  if (early !== undefined) {
    deps.err(early);
    return { ok: false, code: EXIT_USAGE };
  }
  const stored = readInstallRecord(deps.env);
  if (!stored.ok && !options.reconfigure) {
    deps.err(stored.message);
    deps.err((options.hints ?? INSTALL_HINTS).recordDamaged);
    return { ok: false, code: EXIT_RUNTIME };
  }
  const record = stored.ok ? stored.record : undefined;
  if (record && !options.reconfigure && options.harness === undefined) {
    const harness = HARNESSES.find((h) => h.id === record.harness) as HarnessInfo;
    deps.out(`Using ${harness.displayName}, stored in install.yml. Run trellis-crew install --reconfigure to choose again.`);
    return { ok: true, harness, stored: record.transport };
  }
  // Only auto-detect reads the variable here, because it must decide whether to probe Codex at all.
  const codexOff = options.harness === undefined ? codexExperimentalProblem(deps.env.vars) : undefined;
  const candidates =
    options.harness === undefined
      ? await probeHarnesses(deps.env, deps.runner, { warn: deps.err, ...(codexOff === undefined ? {} : { skip: ['codex'] as const }) })
      : [];
  // With the flag off, Codex is never probed. If it is the only harness here, say why it is not offered.
  if (codexOff !== undefined && options.harness === undefined && candidates.length === 0 && findBinary('codex', deps.env.path) !== undefined) {
    deps.err(codexOff);
    return { ok: false, code: EXIT_USAGE };
  }
  const result = await confirmHarness({
    candidates,
    ...(options.harness === undefined ? {} : { harnessFlag: options.harness }),
    nonInteractive: options.nonInteractive,
    isTTY: deps.env.stdinIsTTY,
    ask: deps.ask ?? terminalAsk(),
    out: deps.out,
  });
  if (!result.ok) {
    for (const line of result.lines) deps.err(line);
    return { ok: false, code: result.code };
  }
  if (options.keepStoredTransport === true && record?.harness === result.harness.id) {
    deps.out(`Keeping the ${record.transport} transport, stored in install.yml.`);
    return { ok: true, harness: result.harness, stored: record.transport };
  }
  return { ok: true, harness: result.harness };
}

/**
 * Explains the inbound setting and gets the operator's consent for it.
 * `--skip-inbound` declines and `--yes` consents, with no question. A
 * terminal asks, and the default answer is no. With no terminal and
 * neither flag, consent is missing, so the setting is not changed.
 */
async function inboundConsent(
  target: InboundTarget,
  displayName: string,
  options: InstallOptions,
  deps: CliDeps,
): Promise<'granted' | 'declined' | 'missing'> {
  const key = target.keyPath.join('.');
  if (options.skipInbound) {
    deps.out(`Skipped the inbound setting. ${key} in ${target.settingsPath} is unchanged, so native messages may not reach the team.`);
    return 'declined';
  }
  deps.out(`Install sets ${key} to accept in ${target.settingsPath}, after a dated backup.`);
  deps.out(`This applies to every ${displayName} session for this user, not only the team.`);
  deps.out('Any session on this machine can then queue messages to those sessions.');
  deps.out('trellis-crew stop does not undo it. To undo it, restore the backup or edit the file.');
  if (options.yes) return 'granted';
  if (options.nonInteractive || !deps.env.stdinIsTTY) {
    deps.err(`The inbound setting was not changed, because nothing confirmed it. ${(options.hints ?? INSTALL_HINTS).inboundMissing}`);
    return 'missing';
  }
  const answer = (await (deps.ask ?? terminalAsk())(`Set ${key} to accept? [y/N] `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return 'granted';
  deps.out(`Left ${key} unchanged, so native messages may not reach the team.`);
  return 'declined';
}

/**
 * Detects and confirms the harness, installs the plugin, sets the inbound
 * setting on Claude Code, writes install.yml, and creates the mailbox
 * folder for the file transport.
 */
export async function runInstall(options: InstallOptions, deps: CliDeps): Promise<number> {
  const chosen = await chooseHarness(options, deps);
  if (!chosen.ok) return chosen.code;
  const { harness } = chosen;
  // Codex is behind an experimental flag in this version, however it was chosen. Nothing is written before this.
  if (harness.id === 'codex') {
    const experimental = codexExperimentalProblem(deps.env.vars);
    if (experimental !== undefined) {
      deps.err(experimental);
      return EXIT_USAGE;
    }
  }

  const transport: Transport = options.transport ?? chosen.stored ?? resolveTransport('auto', harness.tier, {});
  if (transport === 'native' && harness.tier !== 1) {
    deps.err(`${harness.displayName} has no native peer messaging. Use --transport file.`);
    return EXIT_USAGE;
  }

  // The file mailbox folder comes from ./sagespec.yml when one is here. A
  // cloned folder can hold another author's roles file, so it is shown and
  // confirmed, as start does, before anything is written.
  let roles: Pick<RolesConfig, 'mailbox'> = {};
  if (transport === 'file-mailbox') {
    const found = loadTeam({ env: deps.env, ...(options.roles === undefined ? {} : { roles: options.roles }) });
    if (!found.ok) {
      for (const line of found.lines) deps.err(line);
      return EXIT_USAGE;
    }
    if (found.file !== null && options.roles === undefined) {
      const asking = { ...deps, env: { ...deps.env, stdinIsTTY: deps.env.stdinIsTTY && !options.nonInteractive } };
      const stop = await confirmFoundRoles(found.file, found.config, (options.rolesYes ?? options.yes) === true, asking, {
        heading: 'Roles file found in this folder',
        question: 'Use this roles file? [y/N] ',
        noTerminal: (options.hints ?? INSTALL_HINTS).rolesNoTerminal,
        declined: 'Nothing was installed.',
      });
      if (stop !== undefined) return stop;
    }
    roles = found.config;
  }

  let complete = true;
  let pluginVersion: string | null = null;
  const adapter = adapterFor(harness.id, deps.adapters);
  const binaryPath = findBinary(harness.binary, deps.env.path);
  if (adapter?.installPlugin === undefined) {
    deps.err(`The plugin install on ${harness.displayName} is not built yet, so no plugin was installed.`);
    complete = false;
  } else if (binaryPath === undefined) {
    deps.err(`${harness.displayName} is not on PATH, so the plugin cannot be installed.`);
    return EXIT_RUNTIME;
  } else {
    const installed = await adapter.installPlugin({ env: deps.env, runner: deps.runner, binaryPath, out: deps.out });
    if (installed.ok) {
      pluginVersion = bundledPluginVersion();
      deps.out(`Installed the trellis-crew plugin ${pluginVersion} on ${harness.displayName}.`);
    } else if (installed.skipped) {
      deps.err(`No plugin was installed on ${harness.displayName}: ${installed.message}`);
      complete = false;
    } else {
      deps.err(`The plugin install failed: ${installed.message}`);
      return EXIT_RUNTIME;
    }
  }

  const target = adapter?.inboundTarget?.(deps.env);
  if (target !== undefined) {
    const folder = dirname(target.settingsPath);
    if (!existsSync(folder)) {
      deps.err(`The ${harness.displayName} configuration folder ${folder} does not exist yet. Run ${harness.displayName} once, then run install again.`);
      return EXIT_RUNTIME;
    }
    const consent = await inboundConsent(target, harness.displayName, options, deps);
    if (consent === 'granted') {
      const inbound = setInboundAccept(target, { now: deps.now?.() ?? new Date(), out: deps.out });
      if (!inbound.ok) {
        deps.err(inbound.message);
        return EXIT_RUNTIME;
      }
    } else if (consent === 'missing') {
      complete = false;
    }
  }

  writeInstallRecord(deps.env, { harness: harness.id, transport, plugin_version: pluginVersion, cli_version: cliVersion() });
  deps.out(`Recorded ${harness.displayName} with the ${transport} transport in install.yml.`);

  if (transport === 'file-mailbox') {
    const folder = ensureMailboxFolder(mailboxPath(roles, deps.env));
    if (!folder.ok) {
      deps.err(folder.message);
      return EXIT_RUNTIME;
    }
    deps.out(`Mailbox folder: ${folder.path}`);
  }
  return complete ? EXIT_OK : EXIT_RUNTIME;
}
