import { randomUUID } from 'node:crypto';
import { MODEL_STEP, type StepOptions, type Steps } from '@lens/testbed/loop.ts';
import { crashPoint, Phase } from './crash.ts';
import { type Lease, type RunStore, StepState } from './run-store.ts';

// Durable steps: the loop's `Steps`, backed by the step log. Steps are numbered in the order
// the loop asks for them, so a resumed run lines up with the run that crashed.

// Two switches exist only so the tests can show the failures they prevent: a fresh key on
// every attempt lets a repeated refund through, and not recording model responses makes a
// resumed run ask the model again.
export const KeyMode = { Stable: 'stable', PerAttempt: 'per-attempt' } as const;
export type KeyMode = (typeof KeyMode)[keyof typeof KeyMode];
export type DurableOptions = { keyMode?: KeyMode; recordModel?: boolean; signal?: AbortSignal };

// An intent with no result, for a side effect whose receiver doesn't deduplicate: the effect
// may have happened, and sending it again could do it twice. Someone has to check first.
export class OutcomeUnknown extends Error {
  constructor(seq: number, name: string, key: string) {
    super(`Step ${seq} (${name}) may already have taken effect under key ${key}; it can't be sent again safely.`);
  }
}

// A resumed run asked for a different step than the one recorded at that position: its
// control flow has changed, so nothing recorded from here on can be trusted.
export class StepMismatch extends Error {
  constructor(seq: number, recorded: string, requested: string) {
    super(`Step ${seq} was recorded as ${recorded} but the resumed run asked for ${requested}.`);
  }
}

export function durableSteps(store: RunStore, lease: Lease, options: DurableOptions = {}): Steps {
  const { keyMode = KeyMode.Stable, recordModel = true, signal } = options;
  let seq = 0;

  return {
    async run<T>(name: string, work: (key: string, signal?: AbortSignal) => Promise<T>, { hasSideEffect = false, deduplicates = false }: StepOptions = {}): Promise<T> {
      signal?.throwIfAborted(); // the lease is gone: stop before doing anything more
      seq += 1;
      const recorded = await store.step(lease.runId, seq);
      if (recorded && recorded.name !== name) throw new StepMismatch(seq, recorded.name, name);

      // Finished before the crash: return what was recorded. Never redo it.
      if (recorded?.state === StepState.Done) return recorded.output as T;

      const key = keyMode === KeyMode.Stable ? (recorded?.idempotencyKey ?? `${lease.runId}:${seq}`) : randomUUID();

      // Crashed between the intent and the result: re-send only if the receiver deduplicates.
      if (recorded?.state === StepState.Intent && !deduplicates) throw new OutcomeUnknown(seq, name, key);

      // Write ahead: record what we're about to do before doing it.
      if (hasSideEffect && !recorded) await store.recordIntent(lease, seq, name, key);
      crashPoint(Phase.AfterIntent, name, seq);

      const output = asRecorded(await work(key, signal)); // a lost lease cancels the call in flight
      crashPoint(Phase.AfterEffect, name, seq);

      if (name === MODEL_STEP && !recordModel) return output;

      await store.recordResult(lease, seq, name, output);
      crashPoint(Phase.AfterResult, name, seq);
      return output;
    },
  };
}

// The value exactly as the step log will hand it back on replay (JSON: dates become strings,
// undefined values become null or disappear), so a first run and a resumed run see the same thing.
function asRecorded<T>(output: T): T {
  return JSON.parse(JSON.stringify(output ?? null));
}
