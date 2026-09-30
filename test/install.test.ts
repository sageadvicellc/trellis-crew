import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hermesAdapter } from '../src/adapters/hermes.ts';
import { main, type CliDeps } from '../src/cli.ts';
import { readInstallRecord, writeInstallRecord } from '../src/store/install-yml.ts';
import { cliVersion } from '../src/versions.ts';
import { makeTestEnv } from './helpers/env.ts';
import { capture } from './helpers/io.ts';
import { recordingRunner, type RecordingRunner } from './helpers/recording-runner.ts';
import { fixtureBin } from './helpers/paths.ts';
import type { Env } from '../src/env.ts';
import { installedInRepo } from './helpers/team.ts';

interface Rig {
  env: Env;
  runner: RecordingRunner;
  out: ReturnType<typeof capture>;
  err: ReturnType<typeof capture>;
  deps: CliDeps;
}

function rig(options: { claudeDir?: boolean } = {}): Rig {
  const env = makeTestEnv();
  if (options.claudeDir !== false) mkdirSync(join(env.home, '.claude'));
  const runner = recordingRunner((command) =>
    command.endsWith('claude')
      ? { code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '', timedOut: false }
      : { code: 1, stdout: '', stderr: '', timedOut: false },
  );
  const out = capture();
  const err = capture();
  const ask = vi.fn(async () => '');
  return { env, runner, out, err, deps: { env, runner, out: out.write, err: err.write, ask, now: () => new Date('2026-03-04T10:00:00Z') } };
}

function versionProbes(runner: RecordingRunner): string[] {
  return runner.calls.filter((c) => c.kind === 'run' && c.args.includes('--version')).map((c) => c.command);
}

describe('install', () => {
  it('33: install.yml holds the harness, the transport, and the plugin version', async () => {
    const t = rig();
    await main(['install', '--non-interactive', '--yes'], t.deps);
    const record = readInstallRecord(t.env);
    expect(record).toMatchObject({ ok: true, record: { harness: 'claude-code', transport: 'native', cli_version: cliVersion() } });
    expect(readFileSync(join(t.env.home, '.trellis-crew', 'install.yml'), 'utf8')).toMatch(/plugin_version:/);
  });

  it('33: --harness and --transport file are stored as given', async () => {
    const t = rig();
    await main(['install', '--harness', 'hermes', '--transport', 'file'], t.deps);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'hermes', transport: 'file-mailbox' } });
    expect(versionProbes(t.runner)).toEqual([]);
  });

  it('33: a plugin install that is not built yet exits 1 and says so, and still records the choice', async () => {
    const t = rig();
    const { installPlugin: _unused, ...unbuilt } = hermesAdapter;
    expect(await main(['install', '--harness', 'hermes'], { ...t.deps, adapters: { hermes: unbuilt } })).toBe(1);
    expect(t.err.text()).toMatch(/Hermes Agent.*not built yet/);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'hermes', plugin_version: null } });
  });

  it('34: a file-mailbox install creates the mailbox folder', async () => {
    // Codex exports its skills into the project, so the install runs at a git worktree top.
    const t = installedInRepo('codex', 'file-mailbox');
    expect(await main(['install', '--harness', 'codex'], t.deps)).toBe(0);
    const folder = join(t.env.home, '.trellis-crew', 'mailbox');
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(t.out.text()).toContain(folder);
  });

  it('34: a native install creates no mailbox folder', async () => {
    const t = rig();
    await main(['install', '--non-interactive', '--yes'], t.deps);
    expect(existsSync(join(t.env.home, '.trellis-crew', 'mailbox'))).toBe(false);
  });

  it('35: without --reconfigure the stored choice is reused and no probe runs', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'hermes', transport: 'file-mailbox', plugin_version: null });
    await main(['install', '--non-interactive', '--yes'], t.deps);
    expect(versionProbes(t.runner)).toEqual([]);
    expect(t.out.text()).toMatch(/Using Hermes Agent, stored in install\.yml/);
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'hermes' } });
  });

  it('35: --reconfigure reruns detection', async () => {
    const t = rig();
    writeInstallRecord(t.env, { harness: 'hermes', transport: 'file-mailbox', plugin_version: null });
    await main(['install', '--reconfigure', '--non-interactive'], t.deps);
    expect(versionProbes(t.runner)).toContain(join(fixtureBin, 'claude'));
    expect(readInstallRecord(t.env)).toMatchObject({ ok: true, record: { harness: 'claude-code', transport: 'native' } });
  });

  it('asks on a terminal, and no candidate exits 1 with the install pages', async () => {
    const t = rig();
    const ask = vi.fn(async () => 'y');
    await main(['install'], { ...t.deps, env: { ...t.env, stdinIsTTY: true }, ask });
    expect(ask).toHaveBeenCalledWith('Use Claude Code? [Y/n/other] ');

    const empty = rig({ claudeDir: false });
    const bare = { ...empty.deps, env: { ...empty.env, path: join(empty.env.home, 'no-bin') } };
    expect(await main(['install', '--non-interactive'], bare)).toBe(1);
    expect(empty.err.text()).toContain('install page: not documented yet');
    expect(existsSync(join(empty.env.home, '.trellis-crew'))).toBe(false);
  });

  it('on Claude Code, sets crossSessionInbound after a dated backup', async () => {
    const t = rig();
    const settings = join(t.env.home, '.claude', 'settings.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(settings, '{"theme": "dark"}\n');
    await main(['install', '--non-interactive', '--yes'], t.deps);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark', crossSessionInbound: 'accept' });
    expect(existsSync(`${settings}.2026-03-04.bak`)).toBe(true);
    expect(t.out.text()).toContain(`${settings}.2026-03-04.bak`);
  });

  it('on Claude Code, the inbound setting needs consent: it explains, then asks, or takes --yes', async () => {
    const { writeFileSync } = await import('node:fs');
    const setUp = (argv: string[], answer = '', tty = false) => {
      const t = rig();
      const settings = join(t.env.home, '.claude', 'settings.json');
      writeFileSync(settings, '{"theme": "dark"}\n');
      const ask = vi.fn(async () => answer);
      const env = { ...t.env, stdinIsTTY: tty };
      return { t, settings, ask, run: () => main(['install', ...argv], { ...t.deps, env, ask }) };
    };
    const unchanged = (settings: string) => {
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark' });
      expect(existsSync(`${settings}.2026-03-04.bak`)).toBe(false);
    };

    // No terminal and no --yes: it explains, changes nothing, and exits 1.
    const quiet = setUp(['--non-interactive']);
    expect(await quiet.run()).toBe(1);
    unchanged(quiet.settings);
    expect(quiet.t.out.text()).toMatch(/every Claude Code session/);
    expect(quiet.t.out.text()).toMatch(/stop does not undo it/);
    expect(quiet.t.err.text()).toMatch(/--yes.*--skip-inbound/);
    expect(readInstallRecord(quiet.t.env)).toMatchObject({ ok: true, record: { harness: 'claude-code' } });

    // A terminal asks. No leaves the file alone and the install still finishes.
    const no = setUp(['--harness', 'claude-code'], 'n', true);
    expect(await no.run()).toBe(0);
    unchanged(no.settings);
    expect(no.ask).toHaveBeenCalledWith(expect.stringMatching(/Set crossSessionInbound to accept\? \[y\/N\]/));

    const yes = setUp(['--harness', 'claude-code'], 'y', true);
    expect(await yes.run()).toBe(0);
    expect(JSON.parse(readFileSync(yes.settings, 'utf8'))).toEqual({ theme: 'dark', crossSessionInbound: 'accept' });

    // --yes sets it with no question. --skip-inbound never touches the file.
    const flag = setUp(['--non-interactive', '--yes']);
    expect(await flag.run()).toBe(0);
    expect(flag.ask).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(flag.settings, 'utf8'))).toEqual({ theme: 'dark', crossSessionInbound: 'accept' });

    const skip = setUp(['--non-interactive', '--skip-inbound']);
    expect(await skip.run()).toBe(0);
    expect(skip.ask).not.toHaveBeenCalled();
    unchanged(skip.settings);
    expect(skip.t.out.text()).toMatch(/Skipped the inbound setting/);
  });

  it('--yes and --skip-inbound together are a usage error', async () => {
    const t = rig();
    expect(await main(['install', '--yes', '--skip-inbound'], t.deps)).toBe(2);
  });

  it('on Claude Code, an invalid settings file stops the install before install.yml', async () => {
    const t = rig();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(t.env.home, '.claude', 'settings.json'), '{ broken');
    expect(await main(['install', '--non-interactive', '--yes'], t.deps)).toBe(1);
    expect(existsSync(join(t.env.home, '.trellis-crew', 'install.yml'))).toBe(false);
  });

  it('native messaging on a harness without it is a usage error', async () => {
    const t = rig();
    expect(await main(['install', '--harness', 'codex', '--transport', 'native'], t.deps)).toBe(2);
    expect(existsSync(join(t.env.home, '.trellis-crew'))).toBe(false);
  });
});
