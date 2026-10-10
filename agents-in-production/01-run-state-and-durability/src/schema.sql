-- Run state for Chapter 1.

-- One row per run. Written when the run is accepted (S1.1), before any step runs.
create table if not exists runs (
  id               text primary key,
  conversation_id  text not null,
  input            text not null,
  version          text not null,                 -- the prompt, model and tool versions, as one agent version (S1.5)
  migrations       jsonb not null default '[]',   -- every explicit move to a new version, in order
  state            text not null check (state in ('accepted', 'running', 'done', 'failed', 'resolved')),
  owner            text,
  lease_token      bigint not null default 0,     -- the fencing token: grows with every new lease (S1.7)
  lease_expires_at timestamptz,
  outcome          jsonb,
  created_at       timestamptz not null default now()
);

-- What a worker looking for work scans: claimable runs, oldest first (S1.7), and the
-- earlier runs on the same conversation that must have finished first.
create index if not exists runs_claimable on runs (state, lease_expires_at, created_at);
create index if not exists runs_by_conversation on runs (conversation_id, created_at);

-- The step log. A side effect gets an 'intent' row before it runs and becomes 'done'
-- once its result is recorded; model responses are recorded the same way (S1.6).
create table if not exists steps (
  run_id          text not null references runs (id),
  seq             integer not null,
  name            text not null,
  state           text not null check (state in ('intent', 'done')),
  idempotency_key text,
  output          json,                           -- json, not jsonb: a replay reads back the exact text recorded
  primary key (run_id, seq)
);

-- The transcript the next run in a conversation starts from (S1.3 checks it on load).
create table if not exists conversations (
  id       text primary key,
  messages jsonb not null default '[]'
);
