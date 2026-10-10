import { randomUUID } from 'node:crypto';
import type { Agent } from './agent.ts';
import { type Message, type Provider, Role, textBlock, textIn, toolCallsIn, toolResult } from './model.ts';

// A plain agent loop: ask the model, run the tools it asks for, repeat. Everything that
// touches the outside world goes through `steps`, so a chapter can swap in a durable
// implementation without changing the loop.

export type StepOptions = { hasSideEffect?: boolean; deduplicates?: boolean };

export interface Steps {
  run<T>(name: string, work: (idempotencyKey: string, signal?: AbortSignal) => Promise<T>, options?: StepOptions): Promise<T>;
}

export const MODEL_STEP = 'model';
export function toolStep(toolName: string): string {
  return `tool:${toolName}`;
}

// No durability: nothing is recorded, and every attempt gets a fresh key. The naive baseline.
export const directSteps: Steps = {
  run: (_name, work) => work(randomUUID()),
};

export const RunStatus = { Done: 'done', StepLimit: 'step_limit' } as const;

export type RunOutcome =
  | { status: typeof RunStatus.Done; answer: string; transcript: Message[] }
  | { status: typeof RunStatus.StepLimit; transcript: Message[] };

type RunContext = { runId: string; provider: Provider; steps: Steps };

export async function runAgent(agent: Agent, history: Message[], input: string, context: RunContext): Promise<RunOutcome> {
  let transcript: Message[] = [...history, { role: Role.User, content: [textBlock(input)] }];

  for (let step = 0; step < agent.maxSteps; step++) {
    const turn = await context.steps.run(MODEL_STEP, () => askModel(agent, transcript, context));
    transcript = [...transcript, { role: Role.Assistant, content: turn.content }];

    const calls = toolCallsIn(turn.content);
    if (calls.length === 0) {
      return { status: RunStatus.Done, answer: textIn(turn.content), transcript };
    }

    const results = [];
    for (const call of calls) {
      const output = await runTool(agent, call.name, call.input, context.steps);
      results.push(toolResult(call.id, output));
    }
    transcript = [...transcript, { role: Role.User, content: results }];
  }

  return { status: RunStatus.StepLimit, transcript };
}

function askModel(agent: Agent, transcript: Message[], { runId, provider }: RunContext) {
  const tools = Object.values(agent.tools).map((tool) => tool.spec);
  return provider.complete({ runId, system: agent.system, tools, messages: transcript });
}

function runTool(agent: Agent, name: string, input: unknown, steps: Steps): Promise<unknown> {
  const tool = Object.hasOwn(agent.tools, name) ? agent.tools[name] : undefined;
  if (!tool) return Promise.resolve({ error: `Unknown tool: ${name}` });

  return steps.run(toolStep(name), (key, signal) => tool.run(input, { idempotencyKey: key, signal }), {
    hasSideEffect: tool.hasSideEffect,
    deduplicates: tool.deduplicates ?? false,
  });
}
