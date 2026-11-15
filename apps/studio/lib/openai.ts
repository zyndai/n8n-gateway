// A small client for OpenAI's Responses API: one streamed turn with function tools (S2.2). Raw fetch rather than the
// SDK keeps the image small and every request easy to fake in tests. The key is read by the caller and only ever
// sent as the Authorization header; it is never logged or put in an error message.

export interface ToolSpec {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export type InputItem =
  | { role: 'user'; content: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface TurnRequest {
  model: string;
  instructions: string;
  input: InputItem[];
  tools: ToolSpec[];
  previousResponseId?: string;
}

export interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface TurnResult {
  responseId: string;
  text: string;
  calls: FunctionCall[];
}

export type OpenAIErrorKind = 'auth' | 'rate' | 'model' | 'unreachable' | 'other';

export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly kind: OpenAIErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function kindFor(status: number, message: string): OpenAIErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 404 || /model/i.test(message)) return 'model';
  return 'other';
}

export class OpenAIClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OpenAIConfig) {
    this.base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** One streamed turn. `onText` gets each piece of reply text as it arrives. */
  async turn(req: TurnRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: req.model,
          instructions: req.instructions,
          input: req.input,
          tools: req.tools,
          parallel_tool_calls: false,
          store: true,
          stream: true,
          ...(req.previousResponseId ? { previous_response_id: req.previousResponseId } : {}),
        }),
        cache: 'no-store',
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new OpenAIError('OpenAI could not be reached', 'unreachable');
    }
    if (!res.ok) {
      let message = `OpenAI answered ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: unknown } };
        if (typeof body.error?.message === 'string') message = body.error.message.slice(0, 300);
      } catch {
        /* not JSON */
      }
      throw new OpenAIError(message, kindFor(res.status, message), res.status);
    }
    if (!res.body) throw new OpenAIError('OpenAI sent no stream', 'other');

    const out: TurnResult = { responseId: '', text: '', calls: [] };
    const handle = (data: string): void => {
      if (data === '[DONE]') return;
      let ev: unknown;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      if (!isObj(ev)) return;
      switch (ev.type) {
        case 'response.output_text.delta':
          if (typeof ev.delta === 'string') {
            out.text += ev.delta;
            onText(ev.delta);
          }
          break;
        case 'response.output_item.done': {
          const item = ev.item;
          if (isObj(item) && item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') {
            out.calls.push({ callId: item.call_id, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' });
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          if (isObj(ev.response) && typeof ev.response.id === 'string') out.responseId = ev.response.id;
          break;
        case 'response.failed': {
          const e = isObj(ev.response) && isObj(ev.response.error) ? ev.response.error : {};
          const message = typeof e.message === 'string' ? e.message.slice(0, 300) : 'OpenAI could not finish';
          throw new OpenAIError(message, kindFor(0, message));
        }
        case 'error': {
          const message = typeof ev.message === 'string' ? ev.message.slice(0, 300) : 'OpenAI reported an error';
          throw new OpenAIError(message, kindFor(0, message));
        }
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) handle(data);
      }
    }
    if (buf.trim()) {
      const data = buf
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) handle(data);
    }
    if (!out.responseId) throw new OpenAIError('OpenAI ended the reply early', 'other');
    return out;
  }
}
