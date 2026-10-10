# Chapter 1: Run State and Durability

Run state for an agent that survives crashes, restarts and deploys, and the checks that prove it. Builds on the [testbed](../testbed/README.md).

```bash
npm run db:up                                   # from agents-in-production/
npm test -w @lens/01-run-state-and-durability   # every check below
```

## The code

| File | Standard | What it does |
|---|---|---|
| `src/schema.sql` | S1.1, S1.5, S1.7 | `runs` (admission record, version, lease and fencing token), `steps` (the step log), `conversations` |
| `src/run-store.ts` | S1.1, S1.7 | Admission, idempotent admission (the run ID comes from the request; the same ID with a different request is rejected), one lease claim (a given run, or the oldest that needs a worker, with `skip locked`; a run waits while any earlier run on its conversation is unfinished, including a failed one not yet resolved by a person), and fenced writes; the final state and the transcript are written in one fenced statement |
| `src/durable-steps.ts` | S1.1, S1.2, S1.6 | The loop's `Steps`, backed by the step log: replay what's recorded (stopping if the step name differs); record the intent before a side effect, execute with its key, record the result; after a crash, re-send an intent only to a receiver that deduplicates (otherwise: outcome unknown, for a person); stop once the lease is gone, and cancel the call in flight |
| `src/transcript.ts` | S1.3 | Validates a saved transcript and repairs it (orphaned side effect: "outcome unknown"; orphaned read-only call: dropped; duplicate results: first kept; results not first: moved to the front), or rejects it (a result with no call, a split pair) |
| `src/versions.ts` | S1.5 | Keeps a run on the version it started with, or moves it through an explicit migration |
| `src/worker.ts` | all | One worker run: claim (a given run, or any run that needs a worker), settle the version, repair the history, run the agent on durable steps, finish; a lost or expired lease stops the run (the heartbeat has a deadline, so a hanging renewal counts as expired), and any other error fails it for a person; a tool the agent doesn't know counts as side-effecting |
| `src/crash.ts` | tests | Named crash points: the worker kills itself with `SIGKILL` at the point named in `CRASH_AT` |

## The checks

| Test | Standard | What it proves |
|---|---|---|
| `crash-recovery.test.ts` | S1.1, S1.2 | Killed at each of six points, a resumed run refunds exactly once; a worker looking for work finds an accepted run nobody started and a run whose worker died; with a fresh key per attempt, the crash window repeats the refund; a reused key with a different amount is rejected; a retried admission finds the existing run, and the same ID with a different request is rejected; a run that fails after its refund holds its conversation until a person resolves it; a run waits while an earlier run on its conversation is in flight |
| `replay.test.ts` | S1.6 | A resumed run reuses the recorded model response; without it, the model is asked again and refunds a different amount; a resumed run that asks for a different step than the one recorded is stopped; an intent whose receiver doesn't deduplicate is never re-sent; a recorded output reads back exactly as written |
| `transcript.test.ts` | S1.3 | The repair policy, case by case (including an orphan of a tool the agent doesn't know); every repaired case passes the provider rule and an unrepaired orphan doesn't; a stuck conversation continues once repaired |
| `lease.test.ts` | S1.7 | Two workers on one run: one runs it, the other backs off; a claimed run can't be claimed again while its lease is live; workers looking for work take different runs; a stalled worker's writes are rejected by the fencing token; a worker that lost its lease stops before its next step, and its call in flight is cancelled |
| `versions.test.ts` | S1.5 | A run stopped across a deploy resumes on its version, migrates only explicitly, and stops when neither is possible or the target has no agent |

## Worker configuration

| Variable | Default | Meaning |
|---|---|---|
| `LEASE_MS` | `30000` | Lease length; the heartbeat renews it every third of that |
| `PAYMENTS_URL` | `http://localhost:4100` | The testbed payments service |
| `DEPLOYED` | `v1,v2` | Agent versions currently deployed |
| `MIGRATIONS` | none | Explicit moves, e.g. `v1:v2` |
| `SCRIPT` | `refund` | Which scripted conversation the model plays (`src/scripts.ts`) |
| `CRASH_AT` | none | Test only: the crash point, e.g. `after-effect:tool:refund` or `after-result:model#3` |
| `KEY_MODE`, `RECORD_MODEL` | `stable`, on | Test only: `per-attempt` and `off` switch off a safeguard to show the failure it prevents |

Every test that crashes a worker first checks it really died by `SIGKILL`, so a crash point that never fired fails the test.

Run `node src/worker.ts` with no run ID to take the oldest run that needs a worker.

Tested with Node 22.22, TypeScript 7.0.2, Postgres 18, pg 8, Vitest 5.0.3 on 2026-10-10: 54 tests passing.
