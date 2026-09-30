import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { claudeDir, codexDir, type Env } from '../env.ts';
import type { HarnessId } from '../roles/schema.ts';
import type { Runner } from '../runner.ts';

export type Tier = 1 | 2 | 3;

export const TIER_LABELS: Record<Tier, string> = {
  1: 'tier one, native messaging',
  2: 'tier two, A2A',
  3: 'tier three, shared mailbox',
};

export interface HarnessInfo {
  id: HarnessId;
  displayName: string;
  binary: string;
  /** The version command's arguments, or null when none is documented. */
  versionArgs: readonly string[] | null;
  /** The configuration paths to look for. Any one that exists is a hit. */
  configPaths: (env: Env) => string[];
  tier: Tier;
}

/** The supported harnesses, in the spec's probe order. */
export const HARNESSES: readonly HarnessInfo[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    binary: 'claude',
    versionArgs: ['--version'],
    configPaths: (env) => [claudeDir(env)],
    tier: 1,
  },
  {
    // Gap: Qwen Code documents no shell-level version flag, so its probe
    // scores the binary and the folder only.
    id: 'qwen-code',
    displayName: 'Qwen Code',
    binary: 'qwen',
    versionArgs: null,
    configPaths: (env) => [join(env.home, '.qwen')],
    tier: 1,
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    binary: 'hermes',
    versionArgs: ['--version'],
    configPaths: (env) => [join(env.home, '.hermes')],
    tier: 2,
  },
  {
    // Gap: `codex --version` is not confirmed on a fetched page, so a miss
    // here is normal.
    id: 'codex',
    displayName: 'Codex CLI',
    binary: 'codex',
    versionArgs: ['--version'],
    configPaths: (env) => [codexDir(env)],
    tier: 3,
  },
  {
    id: 'amp',
    displayName: 'Amp',
    binary: 'amp',
    versionArgs: ['version'],
    configPaths: (env) => [
      join(env.home, '.config', 'amp', 'settings.json'),
      join(env.home, '.config', 'amp', 'settings.jsonc'),
    ],
    tier: 3,
  },
  {
    // Detected by binary name only, as every other tier-three harness is.
    id: 'opencode',
    displayName: 'OpenCode',
    binary: 'opencode',
    versionArgs: null,
    configPaths: () => [],
    tier: 3,
  },
];

export interface Candidate {
  harness: HarnessInfo;
  /** One hit each for the binary, the version command, and the configuration. */
  hits: number;
  binaryPath?: string;
  version?: string;
  configPath?: string;
}

export interface ProbeOptions {
  /** How long a version command may run before it counts as a miss. */
  timeoutMs?: number;
  /** Prints one line about a probe that failed in a way it did not expect. */
  warn?: (line: string) => void;
  /** Harnesses to leave out entirely: no binary look-up, no version command, no folder check. */
  skip?: readonly HarnessId[];
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** Finds an executable file named `name` in the absolute folders on the Env's PATH. */
export function findBinary(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    // An empty or relative entry resolves against the current folder, which a
    // cloned project controls. Only absolute folders are searched.
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here. Try the next folder.
    }
  }
  return undefined;
}

function versionFrom(stdout: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/.exec(stdout)?.[0];
}

async function probeOne(
  harness: HarnessInfo,
  env: Env,
  runner: Runner,
  timeoutMs: number,
  warn: (line: string) => void,
): Promise<Candidate> {
  const candidate: Candidate = { harness, hits: 0 };
  const binaryPath = findBinary(harness.binary, env.path);
  if (binaryPath !== undefined) {
    candidate.binaryPath = binaryPath;
    candidate.hits += 1;
    if (harness.versionArgs !== null) {
      try {
        const result = await runner.run(binaryPath, harness.versionArgs, { env: env.vars, timeoutMs });
        if (result.code === 0 && !result.timedOut) {
          candidate.hits += 1;
          const version = versionFrom(result.stdout);
          if (version !== undefined) candidate.version = version;
        }
      } catch (error) {
        // Runner.run never throws, so a throw here is unexpected. It is a
        // miss, never a crash, and it leaves a trace.
        const reason = error instanceof Error ? error.message : String(error);
        warn(`warning: ${harness.binary} ${harness.versionArgs.join(' ')} failed unexpectedly, so it counts as a miss: ${reason}`);
      }
    }
  }
  const configPath = harness.configPaths(env).find((p) => existsSync(p));
  if (configPath !== undefined) {
    candidate.configPath = configPath;
    candidate.hits += 1;
  }
  return candidate;
}

/** Best tier first, then most hits. Ties keep the probe order. */
export function sortCandidates(candidates: readonly Candidate[]): Candidate[] {
  const order = (c: Candidate) => HARNESSES.findIndex((h) => h.id === c.harness.id);
  return [...candidates].sort((a, b) => a.harness.tier - b.harness.tier || b.hits - a.hits || order(a) - order(b));
}

/** Probes every harness and returns the candidates, best first. */
export async function probeHarnesses(env: Env, runner: Runner, options: ProbeOptions = {}): Promise<Candidate[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const warn = options.warn ?? (() => {});
  const skip = options.skip ?? [];
  const results = await Promise.all(HARNESSES.filter((h) => !skip.includes(h.id)).map((h) => probeOne(h, env, runner, timeoutMs, warn)));
  return sortCandidates(results.filter((c) => c.hits > 0));
}
