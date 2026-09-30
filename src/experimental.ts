import type { Env } from './env.ts';

/** The variable that turns the experimental Codex CLI support on. */
export const CODEX_EXPERIMENTAL_VARIABLE = 'TRELLIS_EXPERIMENTAL_CODEX';

export const CODEX_EXPERIMENTAL_MESSAGE =
  'Codex CLI support is experimental in this version and arrives in v1. Set TRELLIS_EXPERIMENTAL_CODEX=1 to try it.';

/**
 * Returns the line that refuses Codex CLI, or undefined when it is turned
 * on. Only the exact value `1` turns it on. Every other value, and no
 * value, refuses. Only Codex paths call this. It changes no Codex flag or
 * guard: with the variable set, the existing guards run as before.
 */
export function codexExperimentalProblem(vars: Env['vars']): string | undefined {
  return vars[CODEX_EXPERIMENTAL_VARIABLE] === '1' ? undefined : CODEX_EXPERIMENTAL_MESSAGE;
}
