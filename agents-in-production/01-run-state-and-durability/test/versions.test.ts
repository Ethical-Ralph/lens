import { beforeEach, describe, expect, test } from 'vitest';
import { AgentVersion, ToolName } from '@lens/testbed/agent.ts';
import { toolStep } from '@lens/testbed/loop.ts';
import { crashLabel, Phase } from '../src/crash.ts';
import { RunState } from '../src/run-store.ts';
import { chooseVersion, Resolution } from '../src/versions.ts';
import { admit, crashThenResume, crashWorker, modelCalls, reset, runRow, waitForLeaseToLapse, worker } from './harness.ts';

// S1.5: a run started on v1 and paused across a deploy of v2 resumes on v1 while v1 is still
// deployed, moves to v2 only through a recorded migration, and stops otherwise.

const { V1, V2 } = AgentVersion;
const BOTH = `${V1},${V2}`;
const V1_TO_V2 = `${V1}:${V2}`;
const AFTER_REFUND = crashLabel(Phase.AfterResult, toolStep(ToolName.Refund));
const LOOKUP_TURN = 0;
const FINAL_TURN = 2;
const UNDEFINED_VERSION = 'v9';

describe('chooseVersion', () => {
  test.each([
    ['still deployed', [V1, V2], {}, { kind: Resolution.Pinned, version: V1 }],
    ['retired, with a migration', [V2], { [V1]: V2 }, { kind: Resolution.Migrate, from: V1, to: V2 }],
    ['retired, no migration', [V2], {}, { kind: Resolution.Unknown, version: V1 }],
  ])('%s', (_name, deployed, migrations, expected) => {
    expect(chooseVersion(V1, deployed, migrations)).toEqual(expected);
  });
});

describe('a run paused across a deploy', () => {
  beforeEach(reset);

  async function finalTurnPrompt(runId: string): Promise<string> {
    const [call] = await modelCalls(runId, FINAL_TURN);
    return call.system;
  }

  async function pauseOnV1ThenResume(env: Record<string, string>): Promise<string> {
    const runId = await admit({ version: V1 });
    await crashWorker(runId, AFTER_REFUND, { DEPLOYED: BOTH });
    await waitForLeaseToLapse();
    await worker(runId, env);
    return runId;
  }

  test('resumes on the version it started with', async () => {
    const runId = await admit({ version: V1 });
    await crashThenResume(runId, AFTER_REFUND, { DEPLOYED: BOTH });

    expect(await finalTurnPrompt(runId)).toContain('Look up the order before refunding it.');
  });

  test('moves forward only through a recorded migration', async () => {
    const runId = await pauseOnV1ThenResume({ DEPLOYED: V2, MIGRATIONS: V1_TO_V2 });

    expect((await runRow(runId)).migrations).toEqual([{ from: V1, to: V2 }]);
    expect(await finalTurnPrompt(runId)).toContain('confirm the amount');
    expect(await modelCalls(runId, LOOKUP_TURN)).toHaveLength(1); // recorded steps replay unchanged
  });

  test('stops, rather than guessing, when its version is gone and no migration exists', async () => {
    const runId = await pauseOnV1ThenResume({ DEPLOYED: V2 });

    expect((await runRow(runId)).state).toBe(RunState.Failed);
  });

  test('stops before migrating to a version with no agent definition', async () => {
    const runId = await pauseOnV1ThenResume({ DEPLOYED: `${V2}, ${UNDEFINED_VERSION}`, MIGRATIONS: `${V1}:${UNDEFINED_VERSION}` });

    const run = await runRow(runId);
    expect(run.state).toBe(RunState.Failed);
    expect(run.version).toBe(V1); // the bad migration was never recorded
  });
});
