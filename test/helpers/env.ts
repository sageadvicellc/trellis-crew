import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'vitest';
import type { Env } from '../../src/env.ts';
import { fixtureBin } from './paths.ts';

/** A fresh fixture home inside the run's temp home. */
export function makeFixtureHome(): string {
  return realpathSync(mkdtempSync(join(inject('tempHome'), 'fixture-')));
}

/** A test Env. PATH is the fixture bin folder only, unless a test overrides it. */
export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  const home = overrides.home ?? makeFixtureHome();
  const path = overrides.path ?? fixtureBin;
  return {
    home,
    path,
    claudeConfigDir: undefined,
    codexHome: undefined,
    cwd: home,
    stdinIsTTY: false,
    // The experimental Codex flag is on by default here, so the Codex tests reach the code they test.
    // test/codex-flag.test.ts sets the variable itself, off and on. Any new gate test must set the
    // variable itself too, and never rely on this default. A test that leaves it on cannot see a gate.
    vars: { HOME: home, PATH: path, TRELLIS_EXPERIMENTAL_CODEX: '1' },
    ...overrides,
  };
}
