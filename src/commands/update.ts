import { adapterFor } from '../adapters/index.ts';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, type CliDeps } from '../deps.ts';
import { codexExperimentalProblem } from '../experimental.ts';
import { findBinary, HARNESSES } from '../detect/probe.ts';
import { npmFetchLatest, PACKAGE_NAME } from '../registry.ts';
import type { HarnessId } from '../roles/schema.ts';
import { readInstallRecord, writeInstallRecord } from '../store/install-yml.ts';
import { bundledPluginVersion, cliVersion, compareVersions } from '../versions.ts';

/**
 * Each harness's own update command. The CLI prints it and never runs it.
 * A gap is written as a gap, never a guessed command.
 */
export const SELF_UPDATE: Readonly<Record<HarnessId, { command: string } | { gap: string }>> = {
  'claude-code': { command: 'claude update' },
  hermes: { command: 'hermes update' },
  amp: { command: 'amp update' },
  'qwen-code': { gap: 'Qwen Code has no documented update command.' },
  codex: { gap: 'the Codex CLI installer command for an update is not documented yet.' },
  opencode: { gap: 'the OpenCode update command is not documented yet.' },
};

/** A semantic version: major.minor.patch, with an optional pre-release and build part. */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface UpdateOptions {
  check: boolean;
}

/** Compares the CLI with the registry, updates the plugin, and prints the harness's own update command. */
export async function runUpdate(options: UpdateOptions, deps: CliDeps): Promise<number> {
  // The record is read first. With Codex recorded and the flag off, nothing is fetched, printed, updated, or written.
  const stored = readInstallRecord(deps.env);
  if (stored.ok && stored.record?.harness === 'codex') {
    const experimental = codexExperimentalProblem(deps.env.vars);
    if (experimental !== undefined) {
      deps.err(experimental);
      return EXIT_USAGE;
    }
  }
  const current = cliVersion();
  const fetched = await (deps.fetchLatest ?? npmFetchLatest)(PACKAGE_NAME);
  // The registry's value is printed, so a value that is not a version is an error, never echoed.
  const latest =
    fetched.status === 'ok' && !SEMVER_PATTERN.test(fetched.version)
      ? { status: 'error' as const, message: 'the registry returned a value that is not a version' }
      : fetched;
  if (latest.status === 'ok') {
    deps.out(`trellis-crew CLI: installed ${current}, latest on npm ${latest.version}.`);
    if (compareVersions(latest.version, current) > 0) {
      deps.out(`Update the CLI with: npm install -g ${PACKAGE_NAME}@latest`);
    }
  } else if (latest.status === 'not-published') {
    deps.out(`trellis-crew CLI: installed ${current}, latest on npm: not published.`);
  } else {
    deps.err(`trellis-crew CLI: installed ${current}, latest on npm: could not be read (${latest.message}).`);
  }

  if (!stored.ok) {
    deps.err(stored.message);
    return EXIT_RUNTIME;
  }
  if (!stored.record) {
    deps.err('No install record. Run trellis-crew install first.');
    return EXIT_RUNTIME;
  }
  const record = { ...stored.record };
  const harness = HARNESSES.find((h) => h.id === record.harness);
  const name = harness?.displayName ?? record.harness;
  deps.out(`Plugin: installed ${record.plugin_version ?? 'none recorded'}, carried by this CLI ${bundledPluginVersion()}.`);

  let complete = true;
  const adapter = adapterFor(record.harness, deps.adapters);
  if (options.check) {
    deps.out('--check: nothing was changed.');
  } else if (adapter?.updatePlugin === undefined) {
    deps.err(`The plugin update on ${name} is not built yet, so the plugin was not updated.`);
    complete = false;
  } else {
    const binaryPath = harness ? findBinary(harness.binary, deps.env.path) : undefined;
    if (binaryPath === undefined) {
      deps.err(`${name} is not on PATH, so the plugin cannot be updated.`);
      complete = false;
    } else {
      const updated = await adapter.updatePlugin({ env: deps.env, runner: deps.runner, binaryPath, out: deps.out });
      if (updated.ok) {
        record.plugin_version = bundledPluginVersion();
        deps.out(`Updated the trellis-crew plugin to ${record.plugin_version} on ${name}.`);
      } else if (updated.skipped) {
        deps.err(`The plugin was not updated on ${name}: ${updated.message}`);
        complete = false;
      } else {
        deps.err(`The plugin update failed: ${updated.message}`);
        complete = false;
      }
    }
  }

  const self = SELF_UPDATE[record.harness];
  deps.out(
    'command' in self
      ? `To update ${name} itself, run: ${self.command}`
      : `To update ${name} itself: ${self.gap}`,
  );

  if (!options.check) {
    record.cli_version = current;
    writeInstallRecord(deps.env, record);
  }
  return complete ? EXIT_OK : EXIT_RUNTIME;
}
