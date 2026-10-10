import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { type Agent, customerOpsAgent, DEPLOYED_VERSIONS } from '@lens/testbed/agent.ts';
import { connect, type Db } from '@lens/testbed/db.ts';
import { runAgent } from '@lens/testbed/loop.ts';
import { scriptedProvider } from '@lens/testbed/scripted-provider.ts';
import { crashPoint, Phase } from './crash.ts';
import { durableSteps, KeyMode } from './durable-steps.ts';
import { type Lease, LeaseLost, type RunStore, runStore } from './run-store.ts';
import { ScriptName, scripts } from './scripts.ts';
import { repairTranscript } from './transcript.ts';
import { chooseVersion, Resolution } from './versions.ts';

// One worker run: claim the lease, settle the version, repair the history, run the agent on
// durable steps, finish. If the worker dies, its lease lapses and another worker resumes.

export const WorkerResult = { Done: 'done', Failed: 'failed', LeaseUnavailable: 'lease-unavailable', LeaseLost: 'lease-lost' } as const;
export type WorkerResult = (typeof WorkerResult)[keyof typeof WorkerResult];

export type WorkerConfig = {
  leaseMs: number;
  paymentsUrl: string;
  deployed: string[];
  migrations: Record<string, string>;
  script: string;
  keyMode: KeyMode;
  recordModel: boolean;
};

const HEARTBEATS_PER_LEASE = 3;

// Without a run ID, the worker takes the oldest run that needs one: an accepted run nobody
// has started, or a run whose worker died.
export async function work(db: Db, runId: string | null, config: WorkerConfig): Promise<WorkerResult> {
  const store = runStore(db);
  const lease = await store.claim(`${hostname()}:${process.pid}`, config.leaseMs, runId);
  if (!lease) return WorkerResult.LeaseUnavailable;
  crashPoint(Phase.AfterClaim);

  const leaseGone = new AbortController();
  const stopHeartbeat = heartbeat(store, lease, config.leaseMs, leaseGone);
  try {
    return await runClaimed(db, store, lease, config, leaseGone.signal);
  } catch (error) {
    if (error instanceof LeaseLost || leaseGone.signal.aborted) return WorkerResult.LeaseLost;
    // Retries belong inside a step (Chapter 3). An error that reaches here goes to a person.
    return await fail(store, lease, String(error));
  } finally {
    stopHeartbeat();
  }
}

// Renews a few times per lease, one renewal at a time, so a failed renewal is retried before
// the lease runs out. The run stops once the lease is taken over, or once a full lease has
// passed since the last renewal began, even if a renewal is still hanging: either way,
// nothing the run does now can be kept.
function heartbeat(store: RunStore, lease: Lease, leaseMs: number, leaseGone: AbortController): () => void {
  let lastRenewed = Date.now();
  let stopped = false;
  let timer: NodeJS.Timeout;
  const beat = () => {
    timer = setTimeout(async () => {
      const started = Date.now();
      try {
        await withDeadline(store.renew(lease, leaseMs), lastRenewed + leaseMs - started);
        lastRenewed = started;
      } catch (error) {
        if (stopped) return;
        console.error(`Lease renewal failed for run ${lease.runId}: ${error}`);
        if (error instanceof LeaseLost || Date.now() - lastRenewed >= leaseMs) leaseGone.abort(error);
      }
      if (!stopped && !leaseGone.signal.aborted) beat();
    }, leaseMs / HEARTBEATS_PER_LEASE);
  };
  beat();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Lease renewal did not answer before the lease ran out.')), Math.max(ms, 0));
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function runClaimed(db: Db, store: RunStore, lease: Lease, config: WorkerConfig, signal: AbortSignal): Promise<WorkerResult> {
  const run = await store.run(lease.runId);

  const choice = chooseVersion(run.version, config.deployed, config.migrations);
  if (choice.kind === Resolution.Unknown) {
    return fail(store, lease, `Version ${choice.version} is no longer deployed and has no migration.`);
  }
  const version = choice.kind === Resolution.Migrate ? choice.to : choice.version;
  const agent = customerOpsAgent(version, config.paymentsUrl);
  if (!agent) return fail(store, lease, `Version ${version} has no agent definition.`);
  if (choice.kind === Resolution.Migrate) {
    await store.migrate(lease, choice.from, choice.to);
  }

  const history = repairTranscript(await store.history(run.conversationId), readOnlyIn(agent));
  if (!history.ok) {
    return fail(store, lease, `The saved transcript can't be repaired: ${JSON.stringify(history.problems)}`);
  }

  const outcome = await runAgent(agent, history.transcript, run.input, {
    runId: run.id,
    provider: scriptedProvider(db, scripts[config.script]!), // checked at startup
    steps: durableSteps(store, lease, { keyMode: config.keyMode, recordModel: config.recordModel, signal }),
  });
  await store.finish(lease, { status: outcome.status }, outcome.transcript);
  return WorkerResult.Done;
}

// Only a tool the agent knows to be read-only may have its orphaned calls dropped. A tool it
// doesn't know (renamed, removed, or invented by the model) is treated as side-effecting.
export function readOnlyIn(agent: Agent): (tool: string) => boolean {
  return (tool) => Object.hasOwn(agent.tools, tool) && agent.tools[tool]!.hasSideEffect === false;
}

async function fail(store: RunStore, lease: Lease, reason: string): Promise<WorkerResult> {
  try {
    await store.fail(lease, reason);
    return WorkerResult.Failed;
  } catch (error) {
    if (error instanceof LeaseLost) return WorkerResult.LeaseLost; // another worker owns it now
    throw error;
  }
}

// --- Running as a process --------------------------------------------------------

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_PAYMENTS_URL = 'http://localhost:4100';
const EXIT_LEASE_UNAVAILABLE = 3;
export const SWITCH_OFF = 'off';

function configFromEnv(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    leaseMs: Number(env.LEASE_MS ?? DEFAULT_LEASE_MS),
    paymentsUrl: env.PAYMENTS_URL ?? DEFAULT_PAYMENTS_URL,
    deployed: env.DEPLOYED ? listOf(env.DEPLOYED) : DEPLOYED_VERSIONS,
    migrations: parseMigrations(env.MIGRATIONS ?? ''),
    script: knownScript(env.SCRIPT ?? ScriptName.Refund),
    keyMode: env.KEY_MODE === KeyMode.PerAttempt ? KeyMode.PerAttempt : KeyMode.Stable,
    recordModel: env.RECORD_MODEL !== SWITCH_OFF,
  };
}

function knownScript(name: string): string {
  if (!scripts[name]) throw new Error(`Unknown SCRIPT: ${name}`);
  return name;
}

// "v1, v2" → ["v1", "v2"]
function listOf(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

// "v1:v2" → { v1: "v2" }: one explicit move per retired version
function parseMigrations(value: string): Record<string, string> {
  const pairs = listOf(value).map((pair) => pair.split(':').map((part) => part.trim()) as [string, string]);
  return Object.fromEntries(pairs);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const db = connect();
  const result = await work(db, process.argv[2] ?? null, configFromEnv(process.env));
  await db.end();
  console.log(result);
  process.exit(result === WorkerResult.LeaseUnavailable ? EXIT_LEASE_UNAVAILABLE : 0);
}
