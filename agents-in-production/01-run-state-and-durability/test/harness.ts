import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgentVersion } from '@lens/testbed/agent.ts';
import { connect } from '@lens/testbed/db.ts';
import { runStore } from '../src/run-store.ts';

export const db = connect();
export const store = runStore(db);
export const LEASE_MS = 500;
const LEASE_GRACE_MS = 200;
const KILLED = 'SIGKILL';
export { sleep };

export function reset() {
  return db.query('truncate charges, scripted_calls, steps, runs, conversations restart identity cascade');
}

export async function admit(options: { version?: string; conversationId?: string } = {}): Promise<string> {
  const id = `run_${randomUUID().slice(0, 8)}`;
  await store.admit({
    id,
    conversationId: options.conversationId ?? `conversation_${id}`,
    input: 'Please refund ORD-1001.',
    version: options.version ?? AgentVersion.V1,
  });
  return id;
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string };

// Runs the worker as a separate process, so a crash point kills a real process. Without a
// run ID, the worker looks for a run that needs one.
export function worker(runId: string | null, env: Record<string, string> = {}): Promise<Exit> {
  const script = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
  const args = runId ? [script, runId] : [script];
  const child = spawn(process.execPath, args, { env: { ...process.env, LEASE_MS: String(LEASE_MS), ...env } });

  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.trim() })));
}

export async function waitForLeaseToLapse() {
  await sleep(LEASE_MS + LEASE_GRACE_MS);
}

// Runs a worker that must die at the crash point. A worker that slipped past its crash
// point and finished normally would make the test meaningless, so that fails here.
export async function crashWorker(runId: string, crashAt: string, env: Record<string, string> = {}): Promise<Exit> {
  const crashed = await worker(runId, { ...env, CRASH_AT: crashAt });
  if (crashed.signal !== KILLED) throw new Error(`The worker was meant to die at ${crashAt} but exited with ${crashed.code}.`);
  return crashed;
}

// Crash the worker at a point, let its lease lapse, then resume with a fresh worker.
export async function crashThenResume(runId: string, crashAt: string, env: Record<string, string> = {}) {
  const crashed = await crashWorker(runId, crashAt, env);
  await waitForLeaseToLapse();
  const resumed = await worker(runId, env);
  return { crashed, resumed };
}

export async function charges() {
  const { rows } = await db.query('select order_id, amount_minor from charges order by id');
  return rows;
}

export async function modelCalls(runId: string, turn: number) {
  const { rows } = await db.query('select system from scripted_calls where run_id = $1 and turn_index = $2 order by id', [runId, turn]);
  return rows;
}

export async function runRow(runId: string) {
  const { rows } = await db.query('select * from runs where id = $1', [runId]);
  return rows[0];
}
