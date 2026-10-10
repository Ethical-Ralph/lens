# Testbed

The shared system every chapter of *Agents in Production* builds on and tests against: a customer-operations agent, the services it acts on, and a scripted model. It's a lab, not a product. This README is its specification; chapters and tooling take testbed details from here.

## Run it

```bash
npm install            # from agents-in-production/
npm run db:up          # Postgres 18 on localhost:54329 (user/password/db: lens)
npm test               # every chapter's checks
```

Requires Node 22.18 or later (TypeScript runs directly, no build step) and Docker.

## What's in it

| Part | File | What it does |
|---|---|---|
| Conversation model | `src/model.ts` | Provider-neutral messages: text, `tool_call` and `tool_result` blocks; the `Provider` interface |
| Scripted model | `src/scripted-provider.ts` | Plays back scripted turns. Rejects a transcript in which a tool call isn't answered by a `tool_result` first in the very next message, with Anthropic's documented error text. Logs every call in Postgres (`scripted_calls`) so the log survives a crashed process |
| Agent | `src/agent.ts` | The customer-operations agent: `lookup_order` (read-only) and `refund` (side effect, takes an idempotency key). Two versions, `v1` and `v2`, with different system prompts |
| Loop | `src/loop.ts` | A plain agent loop. Every model call and tool call goes through a `Steps` interface (each tool says whether it has a side effect and whether its receiver deduplicates on the key), so a chapter can swap in its own implementation (`directSteps` is the naive one: no records, a new key every attempt) |
| Payments service | `src/payments/` | `POST /refunds` with an optional `Idempotency-Key` header. Keeps the first refund for each key and answers a repeat with a receipt rebuilt from it, marked as replayed; a repeated key with different parameters gets a 422; a request without a key is processed every time. Ledger in `charges` |
| Database | `src/db.ts`, `src/schema.sql` | A pg pool (`DATABASE_URL`, default `postgres://lens:lens@localhost:54329/lens`) and the testbed's tables |

## Scripts

A script is a list of turns: `script[i]` holds the model's answers for the i-th assistant turn. The first time that turn is requested the model gives `script[i][0]`; asked again, `script[i][1]`. A second, different answer is how a test shows a re-asked model changing its mind.

## Configuration

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://lens:lens@localhost:54329/lens` | everything |
| `PAYMENTS_PORT` | `4100` | payments service |

Chapters add their own variables in their READMEs.

## Versions (2026-10-10)

Node 22.18+ (24 LTS recommended), TypeScript 7.0, Postgres 18, pg 8, Vitest 5.
