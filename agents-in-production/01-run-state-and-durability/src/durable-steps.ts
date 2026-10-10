import { randomUUID } from 'node:crypto';
import { MODEL_STEP, type StepOptions, type Steps } from '@lens/testbed/loop.ts';
import { crashPoint, Phase } from './crash.ts';
import { type Lease, type RunStore, type Step as RecordedStep, StepState } from './run-store.ts';

// Durable steps: the loop's `Steps`, backed by the step log. Steps are numbered in the order
// the loop asks for them, so a resumed run lines up with the run that crashed.

// Two switches exist only so the tests can show the failures they prevent: a fresh key on
// every attempt lets a repeated refund through, and not recording model responses makes a
// resumed run ask the model again.
export const KeyMode = { Stable: 'stable', PerAttempt: 'per-attempt' } as const;
export type KeyMode = (typeof KeyMode)[keyof typeof KeyMode];
export type DurableOptions = { keyMode?: KeyMode; recordModel?: boolean; signal?: AbortSignal };

// One step the loop asks for: a model call or a tool call.
export type Step = {
  seq: number;
  name: string;
  hasSideEffect: boolean;
  deduplicates: boolean; // whether the receiver ignores a repeat of the same key
  work: (key: string, signal?: AbortSignal) => Promise<unknown>;
};

// An intent with no result, for a side effect whose receiver doesn't deduplicate: the effect
// may have happened, and sending it again could do it twice. Someone has to check first.
export class OutcomeUnknown extends Error {
  constructor(step: Step, key: string) {
    super(`Step ${step.seq} (${step.name}) may already have taken effect under key ${key}; it can't be sent again safely.`);
  }
}

// A resumed run asked for a different step than the one recorded at that position: its
// control flow has changed, so nothing recorded from here on can be trusted.
export class StepMismatch extends Error {
  constructor(step: Step, recorded: RecordedStep) {
    super(`Step ${step.seq} was recorded as ${recorded.name} but the resumed run asked for ${step.name}.`);
  }
}

export function durableSteps(store: RunStore, lease: Lease, options: DurableOptions = {}): Steps {
  const log = stepLog(store, lease, options);
  let seq = 0;

  return {
    run(name, work, { hasSideEffect = false, deduplicates = false }: StepOptions = {}) {
      seq += 1;
      return runStep({ seq, name, work, hasSideEffect, deduplicates }, log) as Promise<never>;
    },
  };
}

// The rule in one function: replay what's recorded, write ahead, act, record the result.
export async function runStep(step: Step, log: StepLog): Promise<unknown> {
  const recorded = await log.find(step);
  if (recorded?.state === StepState.Done) return recorded.output; // finished before the crash: replay it

  const key = log.keyFor(step, recorded);
  if (recorded && !step.deduplicates) throw new OutcomeUnknown(step, key); // may have happened: check first
  if (step.hasSideEffect && !recorded) await log.recordIntent(step, key); // write ahead

  const output = await log.execute(step, key);
  await log.recordResult(step, output);
  return output;
}

// The step log, with the plumbing the rule doesn't need to show: the lease, the step-name
// guard, keys, cancellation, the JSON round-trip and the test-only switches.
export type StepLog = ReturnType<typeof stepLog>;

function stepLog(store: RunStore, lease: Lease, { keyMode = KeyMode.Stable, recordModel = true, signal }: DurableOptions) {
  return {
    async find(step: Step): Promise<RecordedStep | undefined> {
      signal?.throwIfAborted(); // the lease is gone: stop before doing anything more
      const recorded = await store.step(lease.runId, step.seq);
      if (recorded && recorded.name !== step.name) throw new StepMismatch(step, recorded);
      return recorded;
    },

    // The recorded key on a resume, otherwise the run ID plus the step number.
    keyFor(step: Step, recorded?: RecordedStep): string {
      if (keyMode === KeyMode.PerAttempt) return randomUUID();
      return recorded?.idempotencyKey ?? `${lease.runId}:${step.seq}`;
    },

    async recordIntent(step: Step, key: string): Promise<void> {
      await store.recordIntent(lease, step.seq, step.name, key);
    },

    // Runs the work. A lost lease cancels a call in flight, and the output is turned into
    // exactly what the log will hand back on a replay (JSON), so both paths see the same value.
    async execute(step: Step, key: string): Promise<unknown> {
      crashPoint(Phase.AfterIntent, step.name, step.seq);
      const output = asRecorded(await step.work(key, signal));
      crashPoint(Phase.AfterEffect, step.name, step.seq);
      return output;
    },

    async recordResult(step: Step, output: unknown): Promise<void> {
      if (step.name === MODEL_STEP && !recordModel) return;
      await store.recordResult(lease, step.seq, step.name, output);
      crashPoint(Phase.AfterResult, step.name, step.seq);
    },
  };
}

function asRecorded(output: unknown): unknown {
  return JSON.parse(JSON.stringify(output ?? null));
}
