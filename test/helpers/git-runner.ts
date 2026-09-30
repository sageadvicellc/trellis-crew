import { basename } from 'node:path';
import { createRunner, type RunOptions, type RunResult } from '../../src/runner.ts';
import { recordingRunner, type RecordedCall, type RecordingRunner, type Responder } from './recording-runner.ts';

/** A recording runner that runs `git` for real. Every other command is recorded and spawns nothing. */
export interface GitRunner extends RecordingRunner {
  /** Each git call, kept apart from `calls` so tests that expect no harness call still see none. */
  gitCalls: RecordedCall[];
}

/**
 * Runs `git` with the options the code passes, which include the fixture
 * HOME. Only PATH comes from the test process, since the fixture PATH holds
 * the harness stand-ins and no git.
 */
export function gitRunner(responder?: Responder): GitRunner {
  const real = createRunner();
  const recorder = recordingRunner(responder);
  const gitCalls: RecordedCall[] = [];
  return {
    ...recorder,
    gitCalls,
    async run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
      if (basename(command) !== 'git') return recorder.run(command, args, options);
      gitCalls.push({ kind: 'run', command, args });
      return real.run('git', args, { ...options, env: { ...options.env, PATH: process.env.PATH } });
    },
  };
}
