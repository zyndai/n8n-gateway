import type { FunctionCall, InputItem, TurnRequest, TurnResult } from '@/lib/openai';

/** One scripted model turn: text and/or tool calls. */
export interface Scripted {
  text?: string;
  calls?: { name: string; args: unknown }[];
}

/** A model that follows a script, and records every request it was sent. */
export class FakeModel {
  requests: TurnRequest[] = [];
  private n = 0;
  constructor(private readonly script: Scripted[] | ((req: TurnRequest, n: number) => Scripted)) {}

  turn = async (req: TurnRequest, onText: (d: string) => void): Promise<TurnResult> => {
    this.requests.push(structuredClone(req));
    const step = typeof this.script === 'function' ? this.script(req, this.n) : (this.script[this.n] ?? { text: 'done' });
    this.n += 1;
    const text = step.text ?? '';
    // Deliver the text in two pieces, as a stream would.
    if (text) {
      const mid = Math.ceil(text.length / 2);
      onText(text.slice(0, mid));
      if (text.length > mid) onText(text.slice(mid));
    }
    const calls: FunctionCall[] = (step.calls ?? []).map((c, i) => ({ callId: `call_${this.n}_${i}`, name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) }));
    return { responseId: `resp_${this.n}`, text, calls };
  };
}

export const outputsOf = (input: InputItem[]) => input.filter((i): i is Extract<InputItem, { type: 'function_call_output' }> => 'type' in i).map((i) => ({ id: i.call_id, output: JSON.parse(i.output) as Record<string, unknown> }));
