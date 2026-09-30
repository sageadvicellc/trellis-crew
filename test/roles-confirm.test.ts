import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';
import { readTeam } from '../src/store/team-json.ts';
import { SMALL_TEAM } from './helpers/roles.ts';
import { installedInRepo, installedOn, writeRoles, type Harnessed } from './helpers/team.ts';

const TEAM = SMALL_TEAM.replace('operator: you', 'operator: you\nmailbox: ~/team-mail')
  .replace('transport: auto', 'transport: file-mailbox')
  .replace('autocompact: 400k', 'autocompact: 400k\n    model: model-a');

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function withAnswer(t: Harnessed, answer: string) {
  const ask = vi.fn(async () => answer);
  return { ask, deps: { ...t.deps, env: { ...t.env, stdinIsTTY: true }, ask } };
}

describe('roles file confirm screen', () => {
  it('shows the harness, transport, mailbox, and each model before start asks', async () => {
    const t = installedOn('qwen-code', 'file-mailbox');
    writeFileSync(join(t.env.cwd, 'sagespec.yml'), TEAM);
    expect(await main(['start', '--yes'], t.deps)).toBe(0);
    const text = t.out.text();
    expect(text).toContain('transport: file-mailbox');
    expect(text).toContain(`mailbox: ${join(t.env.home, 'team-mail')}\n`);
    expect(text).toMatch(/helper-a:\n {2}You help\.\n {2}model: model-a/);
  });

  it('shows the mailbox resolved as start and respawn use it: a relative path, and the default', async () => {
    const relative = installedOn('qwen-code', 'file-mailbox');
    writeFileSync(join(relative.env.cwd, 'sagespec.yml'), TEAM.replace('mailbox: ~/team-mail', 'mailbox: shared/mail'));
    expect(await main(['start', '--yes'], relative.deps)).toBe(0);
    expect(relative.out.text()).toContain(`mailbox: ${join(relative.env.cwd, 'shared', 'mail')}\n`);

    const fallback = installedOn('qwen-code', 'file-mailbox');
    writeFileSync(join(fallback.env.cwd, 'sagespec.yml'), TEAM.replace('\nmailbox: ~/team-mail', ''));
    expect(await main(['start', '--yes'], fallback.deps)).toBe(0);
    expect(fallback.out.text()).toContain(`mailbox: ${join(fallback.env.home, '.trellis-crew', 'mailbox')} (the default)\n`);
  });
});

describe('respawn after the roles file changed', () => {
  async function startedFromFile() {
    const t = installedOn('qwen-code', 'file-mailbox');
    const file = writeRoles(t.env, 'team.yml', TEAM);
    expect(await main(['start', '--roles', file], t.deps)).toBe(0);
    t.runner.calls.length = 0;
    return { t, file };
  }

  it('start records a hash of the roles file', async () => {
    const { t, file } = await startedFromFile();
    const team = readTeam(t.env);
    expect(team.ok && team.record?.roles?.sha256).toBe(sha256(file));
  });

  it('an unchanged file needs no confirm', async () => {
    const { t } = await startedFromFile();
    expect(await main(['respawn', 'helper-a'], t.deps)).toBe(0);
  });

  it('a changed file is shown and confirmed again. --yes skips the question', async () => {
    const quiet = await startedFromFile();
    writeFileSync(quiet.file, TEAM.replace('You help.', 'You help, and something new.'));
    expect(await main(['respawn', 'helper-a'], quiet.t.deps)).toBe(2);
    expect(quiet.t.runner.calls).toEqual([]);
    expect(quiet.t.out.text()).toMatch(/The roles file changed since start/);
    expect(quiet.t.out.text()).toContain('You help, and something new.');
    expect(quiet.t.err.text()).toMatch(/--yes/);

    const no = await startedFromFile();
    writeFileSync(no.file, TEAM.replace('You help.', 'Changed.'));
    const declined = withAnswer(no.t, 'n');
    expect(await main(['respawn', 'helper-a'], declined.deps)).toBe(1);
    expect(no.t.runner.calls).toEqual([]);

    const yes = await startedFromFile();
    writeFileSync(yes.file, TEAM.replace('You help.', 'Changed.'));
    expect(await main(['respawn', 'helper-a', '--yes'], yes.t.deps)).toBe(0);
    expect(yes.t.runner.calls.some((c) => c.kind === 'detached')).toBe(true);
    // The confirmed file is the new baseline.
    const team = readTeam(yes.t.env);
    expect(team.ok && team.record?.roles?.sha256).toBe(sha256(yes.file));
  });
});

describe('install with a roles file in the folder', () => {
  it('shows the file and confirms before it reads the mailbox from it', async () => {
    // Codex exports its skills into the project, so each install runs at a git worktree top.
    const quiet = installedInRepo('codex', 'file-mailbox', { fetchLatest: async () => ({ status: 'not-published' }) });
    writeFileSync(join(quiet.env.cwd, 'sagespec.yml'), TEAM);
    expect(await main(['install', '--harness', 'codex', '--reconfigure', '--non-interactive'], quiet.deps)).toBe(2);
    expect(quiet.out.text()).toContain(`Roles file found in this folder: ${join(quiet.env.cwd, 'sagespec.yml')}`);
    expect(quiet.err.text()).toMatch(/--yes/);
    expect(existsSync(join(quiet.env.home, 'team-mail'))).toBe(false);
    expect(existsSync(join(quiet.env.home, '.agents'))).toBe(false);
    expect(existsSync(join(quiet.env.cwd, '.agents'))).toBe(false);

    const yes = installedInRepo('codex', 'file-mailbox');
    writeFileSync(join(yes.env.cwd, 'sagespec.yml'), TEAM);
    expect(await main(['install', '--harness', 'codex', '--reconfigure', '--yes'], yes.deps)).toBe(0);
    expect(existsSync(join(yes.env.home, 'team-mail'))).toBe(true);

    const asked = installedInRepo('codex', 'file-mailbox');
    writeFileSync(join(asked.env.cwd, 'sagespec.yml'), TEAM);
    const answered = withAnswer(asked, 'y');
    expect(await main(['install', '--harness', 'codex', '--reconfigure'], answered.deps)).toBe(0);
    expect(answered.ask).toHaveBeenCalledWith(expect.stringMatching(/Use this roles file\? \[y\/N\]/));
  });
});
