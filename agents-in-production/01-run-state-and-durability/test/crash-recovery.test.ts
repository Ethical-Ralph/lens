import { beforeEach, describe, expect, test } from 'vitest';
import { ToolName } from '@lens/testbed/agent.ts';
import { requestRefund } from '@lens/testbed/payments/client.ts';
import { MODEL_STEP, toolStep } from '@lens/testbed/loop.ts';
import { crashLabel, Phase } from '../src/crash.ts';
import { KeyMode } from '../src/durable-steps.ts';
import { RunIdReused, RunState } from '../src/run-store.ts';
import { FIRST_AMOUNT, ORDER_ID, ScriptName, SECOND_AMOUNT } from '../src/scripts.ts';
import { WorkerResult } from '../src/worker.ts';
import { admit, charges, crashThenResume, crashWorker, db, reset, runRow, store, waitForLeaseToLapse, worker } from './harness.ts';

// S1.1 and S1.2: kill the worker at every boundary of a run that refunds an order, resume
// with a fresh worker, and check the payments ledger. One refund, every time.

beforeEach(reset);

const PAYMENTS_URL = 'http://localhost:4100';
const REFUND = toolStep(ToolName.Refund);
const LOOKUP = toolStep(ToolName.LookupOrder);

const crashPoints = [
  crashLabel(Phase.AfterClaim), //                accepted and claimed, no step yet
  crashLabel(Phase.AfterResult, MODEL_STEP), //   the model chose a tool, nothing done yet
  crashLabel(Phase.AfterResult, LOOKUP), //       a read finished
  crashLabel(Phase.AfterIntent, REFUND), //       intent recorded, refund not sent
  crashLabel(Phase.AfterEffect, REFUND), //       refund done, result not recorded: the crash window
  crashLabel(Phase.AfterResult, REFUND), //       refund done and recorded
];

describe('a run killed at any point resumes without repeating the refund', () => {
  test.each(crashPoints)('killed %s', async (crashAt) => {
    const runId = await admit();
    const { crashed, resumed } = await crashThenResume(runId, crashAt);

    expect(crashed.signal).toBe('SIGKILL');
    expect(resumed.stdout).toBe(WorkerResult.Done);
    expect(await charges()).toEqual([{ order_id: ORDER_ID, amount_minor: FIRST_AMOUNT }]);
    expect((await runRow(runId)).state).toBe(RunState.Done);
  });
});

test('an accepted run is never lost: a worker looking for work finds and finishes it', async () => {
  const runId = await admit();
  expect((await runRow(runId)).state).toBe(RunState.Accepted);

  expect((await worker(null)).stdout).toBe(WorkerResult.Done);
  expect((await runRow(runId)).state).toBe(RunState.Done);
});

test('a run whose worker died is found by a worker looking for work', async () => {
  const runId = await admit();
  await crashWorker(runId, crashLabel(Phase.AfterEffect, REFUND));
  await waitForLeaseToLapse();

  expect((await worker(null)).stdout).toBe(WorkerResult.Done);
  expect(await charges()).toEqual([{ order_id: ORDER_ID, amount_minor: FIRST_AMOUNT }]);
});

test('without a stable key, the crash window repeats the refund', async () => {
  const runId = await admit();
  await crashThenResume(runId, crashLabel(Phase.AfterEffect, REFUND), { KEY_MODE: KeyMode.PerAttempt });

  expect(await charges()).toHaveLength(2);
});

test('the payments service rejects a reused key with a different amount instead of replaying', async () => {
  await requestRefund(PAYMENTS_URL, { orderId: ORDER_ID, amountMinor: FIRST_AMOUNT }, 'key-1');

  await expect(requestRefund(PAYMENTS_URL, { orderId: ORDER_ID, amountMinor: SECOND_AMOUNT }, 'key-1')).rejects.toThrow(/422/);
  expect(await charges()).toHaveLength(1);
});

test('a retried admission finds the run it already created', async () => {
  const runId = await admit();
  await store.admit({ id: runId, conversationId: `conversation_${runId}`, input: 'Please refund ORD-1001.', version: 'v1' });

  const { rows } = await db.query('select count(*)::int as n from runs where id = $1', [runId]);
  expect(rows[0].n).toBe(1);
});

test('a run that fails after its refund holds the conversation until a person resolves it', async () => {
  const conversationId = 'conversation_held';
  const failed = await admit({ conversationId });
  expect((await worker(failed, { SCRIPT: ScriptName.BreaksAfterRefund })).stdout).toBe(WorkerResult.Failed);

  const next = await admit({ conversationId });
  expect((await worker(next)).stdout).toBe(WorkerResult.LeaseUnavailable); // held: it waits, and isn't failed
  expect((await runRow(next)).state).toBe(RunState.Accepted);
  expect(await charges()).toEqual([{ order_id: ORDER_ID, amount_minor: FIRST_AMOUNT }]);

  await store.resolve(failed); // a person checked the refund and updated the conversation
  expect((await worker(next, { SCRIPT: ScriptName.Reply })).stdout).toBe(WorkerResult.Done);
});

test('a run waits while an earlier run on its conversation is still in flight', async () => {
  const conversationId = 'conversation_busy';
  const first = await admit({ conversationId });
  await admit({ conversationId });

  const taken = await store.claim('worker-a', 30_000);
  expect(taken!.runId).toBe(first);
  expect(await store.claim('worker-b', 30_000)).toBeNull();
});

test('the same run ID with a different request is rejected', async () => {
  const runId = await admit();
  await expect(store.admit({ id: runId, conversationId: `conversation_${runId}`, input: 'Please refund ORD-1002.', version: 'v1' })).rejects.toBeInstanceOf(RunIdReused);
});
