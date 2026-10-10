import { Header, type Refund, type RefundReceipt, REFUNDS_PATH } from './server.ts';

// A call that never answers would hold its step, and the run's lease, for ever.
const TIMEOUT_MS = 10_000;

export async function requestRefund(baseUrl: string, refund: Refund, idempotencyKey?: string, signal?: AbortSignal): Promise<RefundReceipt> {
  const headers: Record<string, string> = { [Header.ContentType]: 'application/json' };
  if (idempotencyKey) headers[Header.IdempotencyKey] = idempotencyKey;

  const response = await fetch(baseUrl + REFUNDS_PATH, {
    method: 'POST',
    headers,
    body: JSON.stringify(refund),
    // Gives up on its own timeout, or as soon as the caller's run loses its lease.
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The payments service responded ${response.status}.`);
  return response.json();
}
