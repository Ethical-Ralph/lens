// The conversation model shared by every chapter. Provider-neutral: adapters map
// these blocks onto each provider's wire format.

export const Role = { User: 'user', Assistant: 'assistant' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const BlockType = { Text: 'text', ToolCall: 'tool_call', ToolResult: 'tool_result' } as const;

export type TextBlock = { type: typeof BlockType.Text; text: string };
export type ToolCall = { type: typeof BlockType.ToolCall; id: string; name: string; input: unknown };
export type ToolResult = { type: typeof BlockType.ToolResult; callId: string; output: unknown };

export type Block = TextBlock | ToolCall | ToolResult;
export type Message = { role: Role; content: Block[] };

export type ToolSpec = { name: string; description: string };

export type ModelRequest = {
  runId: string;
  system: string;
  tools: ToolSpec[];
  messages: Message[];
};

export type ModelTurn = { content: Block[] };

export interface Provider {
  complete(request: ModelRequest): Promise<ModelTurn>;
}

export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function textBlock(text: string): TextBlock {
  return { type: BlockType.Text, text };
}

export function toolResult(callId: string, output: unknown): ToolResult {
  return { type: BlockType.ToolResult, callId, output };
}

export function toolCallsIn(blocks: Block[] = []): ToolCall[] {
  return blocks.filter((block): block is ToolCall => block.type === BlockType.ToolCall);
}

export function toolResultsIn(blocks: Block[] = []): ToolResult[] {
  return blocks.filter((block): block is ToolResult => block.type === BlockType.ToolResult);
}

export function textIn(blocks: Block[]): string {
  const texts = blocks.filter((block): block is TextBlock => block.type === BlockType.Text);
  return texts.map((block) => block.text).join('\n');
}
