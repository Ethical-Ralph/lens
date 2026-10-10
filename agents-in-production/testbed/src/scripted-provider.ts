import type { Db } from './db.ts';
import { type Message, type ModelRequest, type Provider, ProviderError, Role, toolCallsIn, toolResultsIn } from './model.ts';
import type { ModelTurn } from './model.ts';

// A deterministic stand-in for a model API. It plays back scripted turns and enforces the
// same tool-pairing rule real providers do, so a broken transcript fails here as it would
// in production. Calls are logged in Postgres, so the log survives a crashed process.

// script[turn] holds the answers for that assistant turn: the first time the turn is
// requested the model gives script[turn][0]; asked again, script[turn][1], and so on.
// A second, different answer is how a test shows a re-asked model changing its mind.
export type Script = ModelTurn[][];

const BAD_REQUEST = 400;
const SERVER_ERROR = 500;

export function scriptedProvider(db: Db, script: Script): Provider {
  return {
    async complete(request) {
      assertToolPairing(request.messages);

      const turn = assistantTurnsIn(request.messages);
      const timesAskedBefore = await logCall(db, request, turn);
      const answers = script[turn] ?? [];
      const answer = answers[Math.min(timesAskedBefore, answers.length - 1)];

      if (!answer) throw new ProviderError(SERVER_ERROR, `The script has no answer for turn ${turn}.`);
      return answer;
    },
  };
}

function assistantTurnsIn(messages: Message[]): number {
  return messages.filter((message) => message.role === Role.Assistant).length;
}

async function logCall(db: Db, request: ModelRequest, turn: number): Promise<number> {
  const previous = await db.query('select count(*)::int as n from scripted_calls where run_id = $1 and turn_index = $2', [request.runId, turn]);
  await db.query('insert into scripted_calls (run_id, turn_index, system) values ($1, $2, $3)', [request.runId, turn, request.system]);
  return previous.rows[0].n;
}

// Mirrors Anthropic's documented rule: every tool call must be answered by a tool result,
// placed first, in the very next message. OpenAI enforces the same pairing.
export function assertToolPairing(messages: Message[]): void {
  for (const [position, message] of messages.entries()) {
    if (message.role !== Role.Assistant) continue;

    const calls = toolCallsIn(message.content);
    const nextMessage = messages[position + 1];
    const leadingResults = toolResultsIn(nextMessage?.content.slice(0, calls.length));
    const answered = new Set(leadingResults.map((result) => result.callId));
    const unanswered = calls.filter((call) => !answered.has(call.id));

    if (unanswered.length > 0) {
      const ids = unanswered.map((call) => call.id).join(', ');
      throw new ProviderError(
        BAD_REQUEST,
        `tool_use ids were found without tool_result blocks immediately after: ${ids}. ` +
          'Each `tool_use` block must have a corresponding `tool_result` block in the next message.',
      );
    }
  }
}
