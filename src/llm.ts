/**
 * DeepSeek client — OpenAI-compatible Chat Completions with tool calls.
 *
 * Reads DEEPSEEK_API_KEY from the environment. Other knobs:
 *   ADVENTURE_MODEL        (default: deepseek-chat)
 *   ADVENTURE_BASE_URL     (default: https://api.deepseek.com/v1)
 *   ADVENTURE_MAX_TOKENS   (default: 2048)
 *   ADVENTURE_TEMPERATURE  (default: 0.7)
 *
 * The wrapper is intentionally tiny: nothing here is DeepSeek-specific
 * other than the default base URL, so swapping providers is a matter
 * of changing env vars.
 */

export interface ChatToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatResponse {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ChatToolCall[];
  };
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

export class LLMError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = "LLMError";
  }
}

export async function chat(opts: ChatOptions): Promise<ChatResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new LLMError("DEEPSEEK_API_KEY is not set in the environment");
  const baseUrl = process.env.ADVENTURE_BASE_URL ?? DEFAULT_BASE_URL;
  const model = process.env.ADVENTURE_MODEL ?? DEFAULT_MODEL;
  const maxTokens =
    opts.maxTokens ?? Number(process.env.ADVENTURE_MAX_TOKENS ?? "2048");
  const temperature =
    opts.temperature ?? Number(process.env.ADVENTURE_TEMPERATURE ?? "0.7");

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    max_tokens: maxTokens,
    temperature,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LLMError(
      `chat completion failed: HTTP ${res.status}`,
      res.status,
      text,
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: ChatResponse["message"]; finish_reason?: string }[];
    usage?: ChatResponse["usage"];
  };
  const choice = json.choices?.[0];
  if (!choice?.message) {
    throw new LLMError("chat completion: no message in response");
  }
  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? null,
    usage: json.usage,
  };
}
