import { beforeEach, expect, test } from 'vitest';
import { ToolName } from '@lens/testbed/agent.ts';
import { toolStep } from '@lens/testbed/loop.ts';
import { durableSteps } from '../src/durable-steps.ts';
import { LeaseLost } from '../src/run-store.ts';
import { WorkerResult } from '../src/worker.ts';
import { admit, charges, LEASE_MS, reset, store, waitForLeaseToLapse, worker } from './harness.ts';

// S1.7: one worker owns a run at a time, and a worker whose lease has been taken over can
// no longer write, even if it doesn't know it lost the lease.

beforeEach(reset);

const REFUND = toolStep(ToolName.Refund);

test('two workers resuming the same run: one runs it, the other backs off', async () => {
  const runId = await admit();
  const results = await Promise.all([worker(runId), worker(runId)]);

  expect(results.map((result) => result.stdout).sort()).toEqual([WorkerResult.Done, WorkerResult.LeaseUnavailable]);
  expect(await charges()).toHaveLength(1);
});

test('a run already claimed cannot be claimed again while the lease is live', async () => {
  const runId = await admit();
  const first = await store.claim(runId, 'worker-a', LEASE_MS);
  const second = await store.claim(runId, 'worker-b', LEASE_MS);

  expect(first).not.toBeNull();
  expect(second).toBeNull();
});

test('workers looking for work each take a different run', async () => {
  const runIds = [await admit(), await admit()];
  const leases = await Promise.all([store.claimNext('worker-a', LEASE_MS), store.claimNext('worker-b', LEASE_MS)]);

  expect(leases.map((lease) => lease!.runId).sort()).toEqual(runIds.sort());
});

test('a worker paused past its lease has its next write rejected', async () => {
  const runId = await admit();
  const stale = await store.claim(runId, 'worker-a', LEASE_MS);
  await waitForLeaseToLapse(); // worker A stalls, say in a long garbage-collection pause
  const current = await store.claim(runId, 'worker-b', LEASE_MS);

  expect(current!.token).toBeGreaterThan(stale!.token);
  await expect(store.recordIntent(stale!, 1, REFUND, 'key')).rejects.toBeInstanceOf(LeaseLost);
  await expect(store.recordIntent(current!, 1, REFUND, 'key')).resolves.toBeUndefined();
});

test('a worker that has lost its lease stops before its next step', async () => {
  const runId = await admit();
  const lease = await store.claim(runId, 'worker-a', LEASE_MS);
  const leaseGone = new AbortController();
  leaseGone.abort(new LeaseLost(lease!));
  const steps = durableSteps(store, lease!, { signal: leaseGone.signal });

  let ran = false;
  await expect(steps.run(REFUND, async () => (ran = true), { hasSideEffect: true })).rejects.toBeInstanceOf(LeaseLost);
  expect(ran).toBe(false);
});

test('a lost lease cancels the tool call already in flight', async () => {
  const runId = await admit();
  const lease = await store.claim(runId, 'worker-a', LEASE_MS);
  const leaseGone = new AbortController();
  const steps = durableSteps(store, lease!, { signal: leaseGone.signal });

  // A tool that only finishes when its signal tells it to stop; the lease is lost mid-call.
  const call = steps.run(
    REFUND,
    (_key, signal) =>
      new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason));
        leaseGone.abort(new LeaseLost(lease!));
      }),
    { hasSideEffect: true, deduplicates: true },
  );
  await expect(call).rejects.toBeInstanceOf(LeaseLost);
});
