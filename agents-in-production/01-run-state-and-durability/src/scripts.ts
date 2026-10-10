import { ToolName } from '@lens/testbed/agent.ts';
import { BlockType, type ModelTurn, textBlock } from '@lens/testbed/model.ts';
import type { Script } from '@lens/testbed/scripted-provider.ts';

export const ORDER_ID = 'ORD-1001';
export const FIRST_AMOUNT = 5000;
export const SECOND_AMOUNT = 7000; // what the model says if it's asked the refund turn again

export const ScriptName = { Refund: 'refund', Reply: 'reply', BreaksAfterRefund: 'breaks-after-refund' } as const;

function callTool(id: string, name: string, input: unknown): ModelTurn {
  return { content: [{ type: BlockType.ToolCall, id, name, input }] };
}

const lookUpOrder = callTool('call_lookup', ToolName.LookupOrder, { orderId: ORDER_ID });
const refund = (amountMinor: number) => callTool('call_refund', ToolName.Refund, { orderId: ORDER_ID, amountMinor });
const confirm: ModelTurn = { content: [textBlock(`Your refund for ${ORDER_ID} is on its way.`)] };

// The model's answers, turn by turn. A second entry in a turn is the answer it gives if
// it's asked that turn again.
export const scripts: Record<string, Script> = {
  [ScriptName.Refund]: [[lookUpOrder], [refund(FIRST_AMOUNT), refund(SECOND_AMOUNT)], [confirm]],
  // The refund goes through, then the model has no answer: the run fails after its side effect.
  [ScriptName.BreaksAfterRefund]: [[lookUpOrder], [refund(FIRST_AMOUNT)]],
  // A conversation that already has history: the model just answers.
  [ScriptName.Reply]: [[confirm], [confirm], [confirm]],
};
