// The builder conversation (S2.2): send the person's message, let the model call tools until it has nothing left to
// do, and stream what happens. The conversation is continued with `previous_response_id`, so no history is kept here.
import type { InputItem, OpenAIClient } from '../openai';
import { OpenAIError } from '../openai';
import type { BuildEvent } from './events';
import type { BuilderTools } from './tools';

export interface BuilderRun {
  openai: Pick<OpenAIClient, 'turn'>;
  model: string;
  instructions: string;
  tools: BuilderTools;
  userText: string;
  previousResponseId?: string;
  emit(event: BuildEvent): void;
  signal?: AbortSignal;
  log?: Pick<Console, 'warn'>;
  /** Most model turns for one message. Each turn that calls a tool is one. */
  maxTurns?: number;
}

export interface BuilderOutcome {
  /** The last response: the token to continue from. Empty only when nothing was answered. */
  responseId: string;
  /** False when the loop was cut short (turn limit, error). */
  finished: boolean;
  /** Model turns used. */
  turns: number;
}

/** What a person reads when something goes wrong. Never raw error text. */
export function plainBuilderError(err: unknown): string {
  if (err instanceof OpenAIError) {
    if (err.kind === 'rate') return 'Studio is busy right now. Please wait a minute and send your message again.';
    if (err.kind === 'auth' || err.kind === 'model') return 'The builder is not switched on yet. Please check back soon.';
    if (err.kind === 'unreachable') return 'We could not reach the builder. Please try again in a moment.';
  }
  return 'Something went wrong while building. Please try again.';
}

export async function runBuilder(run: BuilderRun): Promise<BuilderOutcome> {
  const maxTurns = run.maxTurns ?? 10;
  let input: InputItem[] = [{ role: 'user', content: run.userText }];
  let previous = run.previousResponseId;
  let spoke = false; // the previous turn wrote text: start the next one on a new line

  const turnOnce = async (tools: BuilderTools['specs']) => {
    let wrote = false;
    const result = await run.openai.turn(
      { model: run.model, instructions: run.instructions, input, tools, ...(previous ? { previousResponseId: previous } : {}) },
      (delta) => {
        if (!wrote && spoke) run.emit({ type: 'text', delta: '\n\n' });
        wrote = true;
        run.emit({ type: 'text', delta });
      },
      run.signal,
    );
    previous = result.responseId;
    if (wrote) spoke = true;
    return result;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (run.signal?.aborted) return { responseId: '', finished: false, turns: turn - 1 };
    const result = await turnOnce(run.tools.specs);
    if (result.calls.length === 0) return { responseId: previous ?? '', finished: true, turns: turn };

    const outputs: InputItem[] = [];
    for (const call of result.calls) {
      outputs.push({ type: 'function_call_output', call_id: call.callId, output: await run.tools.run(call.name, call.arguments) });
    }
    input = outputs;
  }

  // Out of turns with tool results still unanswered. One last turn that cannot call tools settles them, so the
  // conversation can be continued from a clean response next time.
  run.log?.warn(`builder stopped after ${maxTurns} turns`);
  await turnOnce([]);
  return { responseId: previous ?? '', finished: false, turns: maxTurns + 1 };
}
