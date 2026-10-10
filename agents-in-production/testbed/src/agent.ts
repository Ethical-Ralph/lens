import type { ToolSpec } from './model.ts';
import { requestRefund } from './payments/client.ts';

// The testbed's customer-operations agent. A tool either only reads, or has a side
// effect; side-effecting tools receive an idempotency key from the harness, and say whether
// the system they call deduplicates on it (only then is a repeat after a crash harmless).

export const ToolName = { LookupOrder: 'lookup_order', Refund: 'refund' } as const;
export const AgentVersion = { V1: 'v1', V2: 'v2' } as const;
export const CURRENT_VERSION = AgentVersion.V2;
export const DEPLOYED_VERSIONS: string[] = Object.values(AgentVersion);

export type ToolContext = { idempotencyKey: string; signal?: AbortSignal };

export type Tool = {
  spec: ToolSpec;
  hasSideEffect: boolean;
  deduplicates?: boolean;
  run(input: unknown, context: ToolContext): Promise<unknown>;
};

export type Agent = {
  version: string;
  system: string;
  maxSteps: number;
  tools: Record<string, Tool>;
};

const MAX_STEPS = 6;

const orders: Record<string, { status: string; totalMinor: number }> = {
  'ORD-1001': { status: 'delivered', totalMinor: 5000 },
  'ORD-1002': { status: 'shipped', totalMinor: 12000 },
};

const lookupOrder: Tool = {
  spec: { name: ToolName.LookupOrder, description: 'Look up an order by its ID.' },
  hasSideEffect: false,
  async run(input) {
    const { orderId } = input as { orderId: string };
    return orders[orderId] ?? { found: false };
  },
};

function refundTool(paymentsUrl: string): Tool {
  return {
    spec: { name: ToolName.Refund, description: 'Refund an order. Amount in minor units.' },
    hasSideEffect: true,
    deduplicates: true, // the payments service replays its first answer for a repeated key
    run(input, { idempotencyKey, signal }) {
      return requestRefund(paymentsUrl, input as { orderId: string; amountMinor: number }, idempotencyKey, signal);
    },
  };
}

// Two versions, so a chapter can show a paused run resuming across a deploy.
const systemPrompts: Record<string, string> = {
  [AgentVersion.V1]: 'You are a customer-operations agent. Look up the order before refunding it.',
  [AgentVersion.V2]: 'You are a customer-operations agent. Look up the order and confirm the amount before refunding it.',
};

export function customerOpsAgent(version: string, paymentsUrl: string): Agent | undefined {
  const system = systemPrompts[version];
  if (!system) return undefined;

  return {
    version,
    system,
    maxSteps: MAX_STEPS,
    tools: {
      [ToolName.LookupOrder]: lookupOrder,
      [ToolName.Refund]: refundTool(paymentsUrl),
    },
  };
}
