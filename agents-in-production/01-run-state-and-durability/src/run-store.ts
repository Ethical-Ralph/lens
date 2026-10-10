import type { Db } from '@lens/testbed/db.ts';
import type { Message } from '@lens/testbed/model.ts';

// Postgres run state. Every write a worker makes after claiming a run is fenced: it only
// succeeds while the worker still holds the newest lease token (S1.7).

export const RunState = { Accepted: 'accepted', Running: 'running', Done: 'done', Failed: 'failed', Resolved: 'resolved' } as const;
export type RunState = (typeof RunState)[keyof typeof RunState];

export const StepState = { Intent: 'intent', Done: 'done' } as const;
export type StepState = (typeof StepState)[keyof typeof StepState];

export type Lease = { runId: string; token: number };
export type Run = { id: string; conversationId: string; input: string; version: string; state: RunState };
export type Step = { seq: number; name: string; state: StepState; idempotencyKey: string | null; output: unknown };

export class RunIdReused extends Error {}

export class LeaseLost extends Error {
  constructor(lease: Lease) {
    super(`Lease ${lease.token} on run ${lease.runId} has been taken over.`);
  }
}

const CLAIMABLE = [RunState.Accepted, RunState.Running];
const FINISHED = [RunState.Done, RunState.Resolved];

export function runStore(db: Db) {
  // Runs a write only while the lease token is current. Locking the run row stops a new
  // claim from slipping in between the check and the write.
  async function fenced(lease: Lease, write: string, params: unknown[]): Promise<void> {
    const result = await db.query(
      `with owner as (select id from runs where id = $1 and lease_token = $2 for update) ${write}`,
      [lease.runId, lease.token, ...params],
    );
    if (result.rowCount === 0) throw new LeaseLost(lease);
  }

  return {
    // The run ID comes from the request that asked for the run, so a retried request finds
    // the run it already created instead of admitting a second one. The same ID with a
    // different request is a bug upstream, and is rejected rather than silently dropped.
    async admit(run: { id: string; conversationId: string; input: string; version: string }) {
      const inserted = await db.query(
        'insert into runs (id, conversation_id, input, version, state) values ($1, $2, $3, $4, $5) on conflict (id) do nothing returning id',
        [run.id, run.conversationId, run.input, run.version, RunState.Accepted],
      );
      if (inserted.rows[0]) return;
      const existing = await this.run(run.id);
      if (existing.conversationId !== run.conversationId || existing.input !== run.input || existing.version !== run.version) {
        throw new RunIdReused(`Run ${run.id} was first admitted for a different request.`);
      }
    },

    // Takes a run that needs a worker: never started, or its lease has lapsed. With a run ID
    // it takes that run; without one it takes the oldest, skipping rows another worker is
    // claiming right now. A run waits while any earlier run on its conversation is unfinished:
    // still in flight, or failed and not yet resolved by a person. The token goes up by one,
    // so the previous owner's writes now fail.
    async claim(owner: string, leaseMs: number, runId: string | null = null): Promise<Lease | null> {
      const { rows } = await db.query(
        `update runs
            set owner = $1, lease_token = lease_token + 1, state = $3,
                lease_expires_at = now() + make_interval(secs => $2 / 1000.0)
          where id = (select id from runs candidate
                       where state = any($4) and (lease_expires_at is null or lease_expires_at < now())
                         and ($5::text is null or id = $5)
                         and not exists (select 1 from runs earlier
                                          where earlier.conversation_id = candidate.conversation_id
                                            and earlier.created_at < candidate.created_at
                                            and not earlier.state = any($6))
                       order by created_at
                       for update skip locked
                       limit 1)
          returning id, lease_token`,
        [owner, leaseMs, RunState.Running, CLAIMABLE, runId, FINISHED],
      );
      return rows[0] ? { runId: rows[0].id, token: Number(rows[0].lease_token) } : null;
    },

    renew(lease: Lease, leaseMs: number) {
      return fenced(
        lease,
        'update runs set lease_expires_at = now() + make_interval(secs => $3 / 1000.0) where id = (select id from owner) and state = $4',
        [leaseMs, RunState.Running],
      );
    },

    async run(runId: string): Promise<Run> {
      const { rows } = await db.query('select id, conversation_id, input, version, state from runs where id = $1', [runId]);
      const row = rows[0];
      return { id: row.id, conversationId: row.conversation_id, input: row.input, version: row.version, state: row.state };
    },

    async step(runId: string, seq: number): Promise<Step | undefined> {
      const { rows } = await db.query('select seq, name, state, idempotency_key, output from steps where run_id = $1 and seq = $2', [runId, seq]);
      const row = rows[0];
      if (!row) return undefined;
      return { seq: row.seq, name: row.name, state: row.state, idempotencyKey: row.idempotency_key, output: row.output };
    },

    recordIntent(lease: Lease, seq: number, name: string, idempotencyKey: string) {
      return fenced(lease, 'insert into steps (run_id, seq, name, state, idempotency_key) select id, $3, $4, $5, $6 from owner', [
        seq, name, StepState.Intent, idempotencyKey,
      ]);
    },

    recordResult(lease: Lease, seq: number, name: string, output: unknown) {
      return fenced(
        lease,
        `insert into steps (run_id, seq, name, state, output) select id, $3, $4, $5, $6 from owner
         on conflict (run_id, seq) do update set state = excluded.state, output = excluded.output`,
        [seq, name, StepState.Done, JSON.stringify(output ?? null)],
      );
    },

    migrate(lease: Lease, from: string, to: string) {
      return fenced(
        lease,
        `update runs set version = $4, migrations = migrations || jsonb_build_object('from', $3::text, 'to', $4::text)
          where id = (select id from owner)`,
        [from, to],
      );
    },

    async history(conversationId: string): Promise<Message[]> {
      const { rows } = await db.query('select messages from conversations where id = $1', [conversationId]);
      return rows[0]?.messages ?? [];
    },

    // A finished run's state and the transcript the next run starts from are written together,
    // in one fenced statement, so a crash can't leave a finished run whose turns are missing.
    finish(lease: Lease, outcome: unknown, transcript: Message[]) {
      return fenced(
        lease,
        `, finished as (
             update runs set state = $3, outcome = $4, lease_expires_at = null
              where id = (select id from owner)
              returning conversation_id)
         insert into conversations (id, messages) select conversation_id, $5 from finished
         on conflict (id) do update set messages = excluded.messages`,
        [RunState.Done, JSON.stringify(outcome), JSON.stringify(transcript)],
      );
    },

    // A person has checked what a failed run did (S2.7) and brought the conversation up to
    // date; later runs on it may go ahead.
    async resolve(runId: string) {
      await db.query('update runs set state = $2 where id = $1 and state = $3', [runId, RunState.Resolved, RunState.Failed]);
    },

    // A failed run leaves the conversation as it was, for a person to look at.
    fail(lease: Lease, reason: string) {
      return fenced(lease, 'update runs set state = $3, outcome = $4, lease_expires_at = null where id = (select id from owner)', [
        RunState.Failed, JSON.stringify({ reason }),
      ]);
    },
  };
}

export type RunStore = ReturnType<typeof runStore>;
