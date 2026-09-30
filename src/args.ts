import { parseArgs } from 'node:util';
import type { Transport } from './roles/schema.ts';

export type TransportFlag = Transport;

/** The harnesses that `up` installs and starts in one step. */
export const UP_HARNESSES = ['codex', 'claude-code'] as const;
export type UpHarness = (typeof UP_HARNESSES)[number];

export type Command =
  | { name: 'help' }
  | { name: 'version' }
  | {
      name: 'install';
      harness?: string;
      nonInteractive: boolean;
      reconfigure: boolean;
      /** --yes: consent to the inbound setting with no question. */
      yes: boolean;
      /** --skip-inbound: never change the inbound setting. */
      skipInbound: boolean;
      transport?: TransportFlag;
    }
  | { name: 'update'; check: boolean }
  | { name: 'start'; workers?: number; roles?: string; yes: boolean }
  | {
      name: 'up';
      harness: UpHarness;
      workers?: number;
      roles?: string;
      /** --yes: confirm a roles file with no question. It never consents to the inbound setting. */
      yes: boolean;
      /** --accept-inbound: consent to the inbound setting, as install --yes does. */
      acceptInbound: boolean;
      /** --skip-inbound: never change the inbound setting. */
      skipInbound: boolean;
    }
  | { name: 'status' }
  | { name: 'stop'; forceStop: boolean }
  | { name: 'respawn'; session: string; model?: string; effort?: string; autocompact?: string; yes?: boolean; forceStop?: boolean };

export type ParseResult = { ok: true; command: Command } | { ok: false; message: string };

export const USAGE = `Usage:
  trellis-crew install [--harness <name>] [--non-interactive] [--reconfigure] [--transport <name>] [--yes | --skip-inbound]
  trellis-crew update [--check]
  trellis-crew start [--workers N] [--roles sagespec.yml] [--yes]
  trellis-crew up --harness <codex|claude-code> [--workers N] [--roles sagespec.yml] [--yes] [--accept-inbound | --skip-inbound]
    (Codex is experimental in v0.7. Set TRELLIS_EXPERIMENTAL_CODEX=1 to use it.)
  trellis-crew status
  trellis-crew stop [--force-stop]
  trellis-crew respawn <name> [--model M] [--effort E] [--autocompact N] [--yes] [--force-stop]
  trellis-crew --roles sagespec.yml    (shorthand for start with a roles file)`;

// No mcp-mailbox: this build carries the file mailbox only (plan decision 16).
const TRANSPORTS: Record<string, TransportFlag> = {
  file: 'file-mailbox',
  'file-mailbox': 'file-mailbox',
  native: 'native',
  a2a: 'a2a',
};

type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

interface Parsed {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

function parse(args: string[], options: Options, positionals: boolean): Parsed {
  const result = parseArgs({ args, options, allowPositionals: positionals, strict: true });
  return { values: result.values as Parsed['values'], positionals: result.positionals };
}

function parseWorkers(raw: string | undefined): number | undefined | Error {
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) return new Error(`--workers takes a whole number of 1 or more, not "${raw}"`);
  return Number(raw);
}

function parseStart(args: string[]): ParseResult {
  if (args.some((arg) => arg === '--merge-reporters' || arg.startsWith('--merge-reporters='))) {
    return {
      ok: false,
      message: '--merge-reporters was removed, because the default team has no researcher to merge. The default team runs one auditor, benchmark',
    };
  }
  const { values } = parse(
    args,
    {
      workers: { type: 'string' },
      roles: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    false,
  );
  const workers = parseWorkers(typeof values.workers === 'string' ? values.workers : undefined);
  if (workers instanceof Error) return { ok: false, message: workers.message };
  const command: Command = { name: 'start', yes: values.yes === true };
  if (workers !== undefined) command.workers = workers;
  if (typeof values.roles === 'string') command.roles = values.roles;
  return { ok: true, command };
}

/** A `scheme://` address or a `git@` address. `up --roles` takes a local file only. */
function isRemoteAddress(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith('git@');
}

function parseUp(args: string[]): ParseResult {
  const { values } = parse(
    args,
    {
      harness: { type: 'string' },
      workers: { type: 'string' },
      roles: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      'accept-inbound': { type: 'boolean', default: false },
      'skip-inbound': { type: 'boolean', default: false },
    },
    false,
  );
  const harness = values.harness;
  if (typeof harness !== 'string') return { ok: false, message: 'up needs --harness codex or --harness claude-code' };
  if (!(UP_HARNESSES as readonly string[]).includes(harness)) {
    return { ok: false, message: `up takes --harness codex or --harness claude-code, not "${harness}"` };
  }
  const workers = parseWorkers(typeof values.workers === 'string' ? values.workers : undefined);
  if (workers instanceof Error) return { ok: false, message: workers.message };
  const command: Extract<Command, { name: 'up' }> = {
    name: 'up',
    harness: harness as UpHarness,
    yes: values.yes === true,
    acceptInbound: values['accept-inbound'] === true,
    skipInbound: values['skip-inbound'] === true,
  };
  if (command.acceptInbound && command.skipInbound) {
    return { ok: false, message: '--accept-inbound and --skip-inbound cannot be used together' };
  }
  if (workers !== undefined) command.workers = workers;
  if (typeof values.roles === 'string') {
    if (isRemoteAddress(values.roles)) {
      return { ok: false, message: `--roles takes a local file path, not a URL or a git address: "${values.roles}"` };
    }
    command.roles = values.roles;
  }
  return { ok: true, command };
}

function parseInstall(args: string[]): ParseResult {
  const { values } = parse(
    args,
    {
      harness: { type: 'string' },
      'non-interactive': { type: 'boolean', default: false },
      reconfigure: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      'skip-inbound': { type: 'boolean', default: false },
      transport: { type: 'string' },
    },
    false,
  );
  const command: Extract<Command, { name: 'install' }> = {
    name: 'install',
    nonInteractive: values['non-interactive'] === true,
    reconfigure: values.reconfigure === true,
    yes: values.yes === true,
    skipInbound: values['skip-inbound'] === true,
  };
  if (command.yes && command.skipInbound) return { ok: false, message: '--yes and --skip-inbound cannot be used together' };
  if (typeof values.harness === 'string') command.harness = values.harness;
  if (typeof values.transport === 'string') {
    const transport = TRANSPORTS[values.transport];
    if (!transport) {
      return {
        ok: false,
        message: `--transport takes one of ${Object.keys(TRANSPORTS).join(', ')}, not "${values.transport}"`,
      };
    }
    command.transport = transport;
  }
  return { ok: true, command };
}

function parseRespawn(args: string[]): ParseResult {
  const { values, positionals } = parse(
    args,
    {
      model: { type: 'string' },
      effort: { type: 'string' },
      autocompact: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      'force-stop': { type: 'boolean', default: false },
    },
    true,
  );
  if (positionals.length !== 1) return { ok: false, message: 'respawn takes exactly one session name' };
  const command: Extract<Command, { name: 'respawn' }> = { name: 'respawn', session: positionals[0] as string };
  if (values.yes === true) command.yes = true;
  if (values['force-stop'] === true) command.forceStop = true;
  if (typeof values.model === 'string') command.model = values.model;
  if (typeof values.effort === 'string') command.effort = values.effort;
  if (typeof values.autocompact === 'string') command.autocompact = values.autocompact;
  return { ok: true, command };
}

function parseBare(name: 'status', args: string[]): ParseResult {
  parse(args, {}, false);
  return { ok: true, command: { name } };
}

function parseStop(args: string[]): ParseResult {
  const { values } = parse(args, { 'force-stop': { type: 'boolean', default: false } }, false);
  return { ok: true, command: { name: 'stop', forceStop: values['force-stop'] === true } };
}

/** Parses the command line. A usage error returns a message and never throws. */
export function parseCommand(argv: readonly string[]): ParseResult {
  const [first, ...rest] = argv;
  try {
    if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
      return { ok: true, command: { name: 'help' } };
    }
    if (first === '--version' || first === '-v') return { ok: true, command: { name: 'version' } };
    if (first.startsWith('--')) return parseStart([...argv]);
    switch (first) {
      case 'install':
        return parseInstall(rest);
      case 'update': {
        const { values } = parse(rest, { check: { type: 'boolean', default: false } }, false);
        return { ok: true, command: { name: 'update', check: values.check === true } };
      }
      case 'start':
        return parseStart(rest);
      case 'up':
        return parseUp(rest);
      case 'status':
        return parseBare(first, rest);
      case 'stop':
        return parseStop(rest);
      case 'respawn':
        return parseRespawn(rest);
      default:
        return { ok: false, message: `unknown command "${first}"` };
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
