-- Tables owned by the testbed's own services.

-- The payments service's ledger. One row per refund that actually happened.
create table if not exists charges (
  id              serial primary key,
  idempotency_key text unique,
  order_id        text not null,
  amount_minor    integer not null,
  created_at      timestamptz not null default now()
);

-- Every request the scripted model receives, so a test can tell whether a
-- resumed run asked the model again (it survives process restarts).
create table if not exists scripted_calls (
  id          serial primary key,
  run_id      text not null,
  turn_index  integer not null,
  system      text not null,
  created_at  timestamptz not null default now()
);
