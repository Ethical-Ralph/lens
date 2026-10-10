import { BlockType, type Message, Role, type ToolCall, toolCallsIn, toolResult, toolResultsIn } from '@lens/testbed/model.ts';

// Transcript checks and repair (S1.3). Pure functions: a transcript goes in, a verdict
// comes out, and the transcript passed in is never changed. Providers reject any tool call
// that isn't answered by a result, placed first, in the very next message, so a broken
// transcript must be repaired before it's sent, or the conversation is stuck.

export const ProblemKind = {
  OrphanedCall: 'orphaned_call',
  DuplicateResult: 'duplicate_result',
  ResultNotFirst: 'result_not_first',
  ResultWithoutCall: 'result_without_call',
} as const;

export type Orphan = { kind: typeof ProblemKind.OrphanedCall; call: ToolCall; position: number };
export type Problem =
  | Orphan
  | { kind: typeof ProblemKind.DuplicateResult; callId: string; position: number }
  | { kind: typeof ProblemKind.ResultNotFirst; callId: string; position: number }
  | { kind: typeof ProblemKind.ResultWithoutCall; callId: string; position: number };

export type Repair = { ok: true; transcript: Message[]; problems: Problem[] } | { ok: false; problems: Problem[] };

// What an orphaned side effect is told. Dropping the call would invite the model to make
// it again; saying the outcome is unknown tells it to check first.
export const UNKNOWN_OUTCOME = {
  outcome: 'unknown',
  note: 'This call may or may not have taken effect. Check its result before trying it again.',
};

// --- Finding problems ------------------------------------------------------------

export function findProblems(transcript: Message[]): Problem[] {
  return [...findOrphanedCalls(transcript), ...findBadResults(transcript)];
}

export function findOrphanedCalls(transcript: Message[]): Orphan[] {
  const orphans: Orphan[] = [];
  for (const [position, message] of transcript.entries()) {
    if (message.role !== Role.Assistant) continue;
    const answered = resultIdsIn(transcript[position + 1]);
    for (const call of toolCallsIn(message.content)) {
      if (!answered.has(call.id)) orphans.push({ kind: ProblemKind.OrphanedCall, call, position });
    }
  }
  return orphans;
}

function findBadResults(transcript: Message[]): Problem[] {
  const problems: Problem[] = [];
  for (const [position, message] of transcript.entries()) {
    if (message.role !== Role.User) continue;
    const asked = callIdsIn(transcript[position - 1]);
    const seen = new Set<string>();
    for (const [index, block] of message.content.entries()) {
      if (block.type !== BlockType.ToolResult) continue;
      const callId = block.callId;
      if (!asked.has(callId)) problems.push({ kind: ProblemKind.ResultWithoutCall, callId, position });
      else if (seen.has(callId)) problems.push({ kind: ProblemKind.DuplicateResult, callId, position });
      else if (index > 0 && message.content[index - 1]!.type !== BlockType.ToolResult) {
        problems.push({ kind: ProblemKind.ResultNotFirst, callId, position });
      }
      seen.add(callId);
    }
  }
  return problems;
}

// --- Repairing ---------------------------------------------------------------------

export function repairTranscript(transcript: Message[], isReadOnly: (tool: string) => boolean): Repair {
  const problems = findProblems(transcript);

  if (problems.some((problem) => problem.kind === ProblemKind.ResultWithoutCall)) {
    return { ok: false, problems }; // someone must look at it
  }

  let repaired = transcript.map(keepFirstResults).map(resultsFirst);
  for (const orphan of findOrphanedCalls(repaired).reverse()) {
    repaired = isReadOnly(orphan.call.name)
      ? dropCall(repaired, orphan) // safe to forget a lookup
      : addUnknownOutcome(repaired, orphan); // never forget a refund
  }
  return { ok: true, transcript: repaired, problems };
}

function dropCall(transcript: Message[], orphan: Orphan): Message[] {
  const message = transcript[orphan.position]!;
  const remaining = message.content.filter((block) => block !== orphan.call);
  if (remaining.length === 0) return removeAt(transcript, orphan.position);
  return replaceAt(transcript, orphan.position, { ...message, content: remaining });
}

function addUnknownOutcome(transcript: Message[], orphan: Orphan): Message[] {
  const result = toolResult(orphan.call.id, UNKNOWN_OUTCOME);
  const next = transcript[orphan.position + 1];
  if (next?.role === Role.User) {
    return replaceAt(transcript, orphan.position + 1, { ...next, content: [result, ...next.content] });
  }
  return insertAt(transcript, orphan.position + 1, { role: Role.User, content: [result] });
}

function keepFirstResults(message: Message): Message {
  const seen = new Set<string>();
  const content = message.content.filter((block) => {
    if (block.type !== BlockType.ToolResult) return true;
    if (seen.has(block.callId)) return false;
    seen.add(block.callId);
    return true;
  });
  return { ...message, content };
}

function resultsFirst(message: Message): Message {
  const results = message.content.filter((block) => block.type === BlockType.ToolResult);
  const rest = message.content.filter((block) => block.type !== BlockType.ToolResult);
  return { ...message, content: [...results, ...rest] };
}

// --- Small helpers -----------------------------------------------------------------

function resultIdsIn(message?: Message): Set<string> {
  return new Set(toolResultsIn(message?.content).map((result) => result.callId));
}

function callIdsIn(message?: Message): Set<string> {
  return new Set(toolCallsIn(message?.content).map((call) => call.id));
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function insertAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function removeAt<T>(items: T[], index: number): T[] {
  return [...items.slice(0, index), ...items.slice(index + 1)];
}
