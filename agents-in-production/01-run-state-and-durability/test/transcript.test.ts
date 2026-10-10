import { beforeEach, describe, expect, test } from 'vitest';
import { AgentVersion, customerOpsAgent, ToolName } from '@lens/testbed/agent.ts';
import { BlockType, type Message, Role, textBlock, toolResult } from '@lens/testbed/model.ts';
import { assertToolPairing } from '@lens/testbed/scripted-provider.ts';
import { RunState } from '../src/run-store.ts';
import { ScriptName } from '../src/scripts.ts';
import { findProblems, ProblemKind, repairTranscript, UNKNOWN_OUTCOME } from '../src/transcript.ts';
import { readOnlyIn, WorkerResult } from '../src/worker.ts';
import { admit, db, reset, runRow, worker } from './harness.ts';

// S1.3: every tool call has exactly one result. Orphaned tool calls are repaired; anything
// else that can't be repaired is rejected.

function ask(...calls: [id: string, tool: string][]): Message {
  return { role: Role.Assistant, content: calls.map(([id, name]) => ({ type: BlockType.ToolCall, id, name, input: {} })) };
}
function answer(...callIds: string[]): Message {
  return { role: Role.User, content: callIds.map((id) => toolResult(id, { ok: true })) };
}
function textThenAnswer(callId: string): Message {
  return { role: Role.User, content: [textBlock('Also, where is my order?'), toolResult(callId, { ok: true })] };
}
const customer: Message = { role: Role.User, content: [textBlock('Refund ORD-1001')] };
const isReadOnly = (tool: string) => tool === ToolName.LookupOrder;

describe('findProblems', () => {
  test.each([
    ['a complete transcript', [customer, ask(['a', ToolName.Refund]), answer('a')], []],
    ['an orphaned tool call', [customer, ask(['a', ToolName.Refund])], [ProblemKind.OrphanedCall]],
    ['a duplicate result', [customer, ask(['a', ToolName.Refund]), answer('a', 'a')], [ProblemKind.DuplicateResult]],
    ['a result with no call', [customer, answer('x')], [ProblemKind.ResultWithoutCall]],
    ['a result placed after text', [customer, ask(['a', ToolName.Refund]), textThenAnswer('a')], [ProblemKind.ResultNotFirst]],
    ['a split pair (the result arrives a message late)', [customer, ask(['a', ToolName.Refund]), customer, answer('a')], [ProblemKind.OrphanedCall, ProblemKind.ResultWithoutCall]],
  ])('%s', (_name, transcript, kinds) => {
    expect(findProblems(transcript).map((problem) => problem.kind)).toEqual(kinds);
  });
});

describe('repairTranscript', () => {
  test('an orphaned side effect gets an "outcome unknown" result', () => {
    const repair = repairTranscript([customer, ask(['a', ToolName.Refund])], isReadOnly);
    expect(repair.ok && repair.transcript.at(-1)).toEqual({ role: Role.User, content: [toolResult('a', UNKNOWN_OUTCOME)] });
  });

  test('an orphaned read-only call is dropped', () => {
    const repair = repairTranscript([customer, ask(['a', ToolName.LookupOrder])], isReadOnly);
    expect(repair.ok && repair.transcript).toEqual([customer]);
  });

  test('a duplicate result keeps the first', () => {
    const repair = repairTranscript([customer, ask(['a', ToolName.Refund]), answer('a', 'a')], isReadOnly);
    expect(repair.ok && repair.transcript.at(-1)?.content).toHaveLength(1);
  });

  test('an orphaned call to a tool the agent does not know is treated as a side effect', () => {
    const agent = customerOpsAgent(AgentVersion.V1, 'http://localhost:4100')!;
    const repair = repairTranscript([customer, ask(['a', 'refund_v0'])], readOnlyIn(agent));
    expect(repair.ok && repair.transcript.at(-1)).toEqual({ role: Role.User, content: [toolResult('a', UNKNOWN_OUTCOME)] });
    expect(() => assertToolPairing(repair.ok ? repair.transcript : [])).not.toThrow();
  });

  test('a result placed after text is moved to the front', () => {
    const repair = repairTranscript([customer, ask(['a', ToolName.Refund]), textThenAnswer('a')], isReadOnly);
    expect(repair.ok && repair.transcript.at(-1)?.content.map((block) => block.type)).toEqual([BlockType.ToolResult, BlockType.Text]);
  });

  test('a result with no call is rejected', () => {
    expect(repairTranscript([customer, answer('x')], isReadOnly).ok).toBe(false);
  });

  test('a split pair is rejected', () => {
    expect(repairTranscript([customer, ask(['a', ToolName.Refund]), customer, answer('a')], isReadOnly).ok).toBe(false);
  });

  test('an unrepaired orphan is rejected by the provider rule', () => {
    expect(() => assertToolPairing([customer, ask(['a', ToolName.Refund])])).toThrow(/without tool_result blocks/);
  });

  test.each([
    ['an orphaned side effect', [customer, ask(['a', ToolName.Refund])]],
    ['an orphaned read-only call', [customer, ask(['a', ToolName.LookupOrder])]],
    ['both in one message', [customer, ask(['a', ToolName.Refund], ['b', ToolName.LookupOrder])]],
    ['a duplicate result', [customer, ask(['a', ToolName.Refund]), answer('a', 'a')]],
    ['a result placed after text', [customer, ask(['a', ToolName.Refund]), textThenAnswer('a')]],
    ['an orphan followed by the customer', [customer, ask(['a', ToolName.Refund]), customer]],
  ])('the repaired transcript passes the provider rule: %s', (_name, transcript) => {
    const repair = repairTranscript(transcript, isReadOnly);
    expect(repair.ok).toBe(true);
    expect(() => assertToolPairing(repair.ok ? repair.transcript : [])).not.toThrow();
  });
});

describe('a conversation whose saved transcript ends in an orphaned call', () => {
  beforeEach(reset);

  function saveHistory(conversationId: string, transcript: Message[]) {
    return db.query('insert into conversations (id, messages) values ($1, $2)', [conversationId, JSON.stringify(transcript)]);
  }

  test('continues once the orphan is repaired', async () => {
    await saveHistory('conversation_1', [customer, ask(['call_refund', ToolName.Refund])]);
    const runId = await admit({ conversationId: 'conversation_1' });

    expect((await worker(runId, { SCRIPT: ScriptName.Reply })).stdout).toBe(WorkerResult.Done);
    expect((await runRow(runId)).state).toBe(RunState.Done);
  });

  test('is handed to a person when the transcript cannot be repaired', async () => {
    await saveHistory('conversation_2', [customer, answer('call_unknown')]);
    const runId = await admit({ conversationId: 'conversation_2' });

    await worker(runId, { SCRIPT: ScriptName.Reply });
    expect((await runRow(runId)).state).toBe(RunState.Failed);
  });
});
