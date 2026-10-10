import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { connect, type Db } from '../db.ts';

// The testbed's payments service. A refund is the side effect that must never happen twice.
// Like Stripe, it keeps the first refund for each idempotency key and answers any repeat of
// the same request with a receipt rebuilt from that stored refund, marked as a replay; a repeated key with different
// parameters is rejected, and a request without a key is processed every time.

export const REFUNDS_PATH = '/refunds';
export const Header = { IdempotencyKey: 'idempotency-key', Replayed: 'idempotent-replayed', ContentType: 'content-type' } as const;
const JSON_TYPE = 'application/json';
const DEFAULT_PORT = 4100;
const Status = { Ok: 200, BadRequest: 400, NotFound: 404, Unprocessable: 422, ServerError: 500 } as const;

export type Refund = { orderId: string; amountMinor: number };
export type RefundReceipt = { refundId: number; orderId: string; amountMinor: number; replayed: boolean };

// The same idempotency key arrived with a different request: a bug upstream, worth an alert.
export class KeyReused extends Error {}

export async function refund(db: Db, request: Refund, idempotencyKey: string | null): Promise<RefundReceipt> {
  const orderId = String(request.orderId);
  const amountMinor = Number(request.amountMinor);
  const inserted = await db.query(
    `insert into charges (idempotency_key, order_id, amount_minor) values ($1, $2, $3)
     on conflict (idempotency_key) do nothing
     returning id`,
    [idempotencyKey, orderId, amountMinor],
  );
  if (inserted.rows[0]) {
    return { refundId: inserted.rows[0].id, orderId, amountMinor, replayed: false };
  }

  const existing = await db.query('select id, order_id, amount_minor from charges where idempotency_key = $1', [idempotencyKey]);
  const row = existing.rows[0];
  if (row.order_id !== orderId || row.amount_minor !== amountMinor) {
    throw new KeyReused(`Idempotency key ${idempotencyKey} was first used for a different refund.`);
  }
  return { refundId: row.id, orderId, amountMinor, replayed: true };
}

export function startPaymentsServer(db: Db, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== REFUNDS_PATH) {
      res.writeHead(Status.NotFound).end();
      return;
    }
    try {
      const key = req.headers[Header.IdempotencyKey];
      const receipt = await refund(db, await readJson(req), typeof key === 'string' ? key : null);
      res.writeHead(Status.Ok, { [Header.ContentType]: JSON_TYPE, [Header.Replayed]: String(receipt.replayed) });
      res.end(JSON.stringify(receipt));
    } catch (error) {
      res.writeHead(statusFor(error)).end(String(error));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function statusFor(error: unknown): number {
  if (error instanceof SyntaxError) return Status.BadRequest;
  if (error instanceof KeyReused) return Status.Unprocessable;
  return Status.ServerError;
}

async function readJson(req: IncomingMessage): Promise<Refund> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PAYMENTS_PORT ?? DEFAULT_PORT);
  await startPaymentsServer(connect(), port);
  console.log(`Payments service listening on port ${port}`);
}
