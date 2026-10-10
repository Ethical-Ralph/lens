import { beforeEach, expect, test } from 'vitest';
import { ToolName } from '@lens/testbed/agent.ts';
import { MODEL_STEP, toolStep } from '@lens/testbed/loop.ts';
import { crashLabel, Phase } from '../src/crash.ts';
import { FIRST_AMOUNT, ORDER_ID, SECOND_AMOUNT } from '../src/scripts.ts';
import { durableSteps, OutcomeUnknown, StepMismatch } from '../src/durable-steps.ts';
import { SWITCH_OFF } from '../src/worker.ts';
import { admit, charges, crashThenResume, LEASE_MS, modelCalls, reset, store } from './harness.ts';

// S1.6: the scripted model answers FIRST_AMOUNT the first time it's asked for the refund
// turn and SECOND_AMOUNT if it's asked again.
// Steps: 1 model, 2 lookup, 3 model (the refund turn), 4 refund.

beforeEach(reset);

const REFUND_TURN = 1;
const REFUND_TURN_STEP = 3;

test('a resumed run reuses the recorded model response instead of asking again', async () => {
  const runId = await admit();
  await crashThenResume(runId, crashLabel(Phase.AfterResult, MODEL_STEP, REFUND_TURN_STEP));

  expect(await modelCalls(runId, REFUND_TURN)).toHaveLength(1);
  expect(await charges()).toEqual([{ order_id: ORDER_ID, amount_minor: FIRST_AMOUNT }]);
});

test('without recorded responses, the resumed run asks again and refunds a different amount', async () => {
  const runId = await admit();
  await crashThenResume(runId, crashLabel(Phase.AfterEffect, MODEL_STEP, REFUND_TURN_STEP), { RECORD_MODEL: SWITCH_OFF });

  expect(await modelCalls(runId, REFUND_TURN)).toHaveLength(2);
  expect(await charges()).toEqual([{ order_id: ORDER_ID, amount_minor: SECOND_AMOUNT }]);
});

test('a resumed run that asks for a different step than the one recorded is stopped', async () => {
  const runId = await admit();
  const lease = await store.claim(runId, 'worker-a', LEASE_MS);
  await store.recordIntent(lease!, 1, toolStep(ToolName.Refund), `${runId}:1`);

  const steps = durableSteps(store, lease!);
  await expect(steps.run(MODEL_STEP, async () => 'a different first step')).rejects.toBeInstanceOf(StepMismatch);
});

test('an intent whose receiver does not deduplicate is never sent again', async () => {
  const runId = await admit();
  const lease = await store.claim(runId, 'worker-a', LEASE_MS);
  const SEND_EMAIL = toolStep('send_email');
  await store.recordIntent(lease!, 1, SEND_EMAIL, `${runId}:1`);

  let sent = false;
  const steps = durableSteps(store, lease!);
  await expect(steps.run(SEND_EMAIL, async () => (sent = true), { hasSideEffect: true, deduplicates: false })).rejects.toBeInstanceOf(OutcomeUnknown);
  expect(sent).toBe(false);
});

test('a recorded output reads back exactly as it was written, key order included', async () => {
  const runId = await admit();
  const lease = await store.claim(runId, 'worker-a', LEASE_MS);
  const output = { refundId: 1, orderId: ORDER_ID, amountMinor: FIRST_AMOUNT, replayed: false };
  await store.recordResult(lease!, 1, toolStep(ToolName.Refund), output);

  expect(JSON.stringify((await store.step(runId, 1))!.output)).toBe(JSON.stringify(output));
});
