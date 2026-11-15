import { describe, expect, it } from 'vitest';
import { classifyRunError, fromMicro, parseExecution, parseRequest, toMicro, toolKey, toolLabel } from '@/lib/n8n/runs';

/** The shape of a real `get_workflow_execution` reply (execution 39 on n8n, 2026-11-16), trimmed. */
const REAL = {
  execution: { id: '39', workflowId: 'wf-1', mode: 'manual', status: 'success', startedAt: '2026-11-16T10:21:33.533Z', stoppedAt: '2026-11-16T10:21:43.784Z' },
  data: {
    resultData: {
      runData: {
        'AI step': [
          {
            data: {
              main: [
                [
                  {
                    json: {
                      output: 'Example Domain.',
                      intermediateSteps: [
                        {
                          action: { tool: 'Web_page_reader', toolInput: { url: 'https://example.com' }, messageLog: [{ huge: 'prompt and headers we never forward' }] },
                          observation: '[{"data":"This domain is for use in documentation examples."}]',
                        },
                      ],
                    },
                  },
                ],
              ],
            },
          },
        ],
        Answer: [{ data: { main: [[{ json: { output: 'Example Domain.' } }]] } }],
        Request: [{ data: { main: [[{ json: { request: 'Read https://example.com' } }]] } }],
      },
      lastNodeExecuted: 'Answer',
    },
    executionData: { contextData: { 'node:Web page reader': { response: { headers: { 'cf-ray': 'secret-ish' } } } } },
  },
  resumeToken: 'do-not-forward',
};

const paid = (tool: string, item: Record<string, unknown>) => ({ action: { tool }, observation: JSON.stringify([item]) });
const withSteps = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  execution: { status: 'success', startedAt: '2026-11-16T10:00:00Z' },
  data: { resultData: { runData: { 'AI step': [{ data: { main: [[{ json: { output: 'x', intermediateSteps: steps } }]] } }], Answer: [{ data: { main: [[{ json: { output: 'The answer' } }]] } }] }, ...extra } },
});

describe('parseExecution', () => {
  it('reads a real execution: the answer, no paid helpers, nothing else', () => {
    const v = parseExecution(REAL);
    expect(v).toMatchObject({ status: 'success', answer: 'Example Domain.', reachedAnswer: true, helpers: [], costUsd: '0.000000' });
    // Nothing from the raw data can reach the browser.
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/resumeToken|cf-ray|messageLog|do-not-forward|prompt and headers/);
  });

  it('adds up what helpers and data sources were paid (Zynd paymentUsd, AirnodeHub payment.amountUsd)', () => {
    const v = parseExecution(
      withSteps([
        paid('Counterparty_Check', { taskId: 't1', status: 'COMPLETED', output: {}, paymentUsd: '0.050000' }),
        paid('Wallet_Risk_Screener', { taskId: 't2', status: 'COMPLETED', output: {}, paymentUsd: '0.030000' }),
        paid('Briefpixel_news', { data: {}, attestation: { signature: '0x' }, payment: { amountUsd: '0.010000' } }),
        paid('Web_page_reader', { data: 'text' }),
      ]),
    );
    expect(v.helpers.map((h) => [h.name, h.costUsd, h.ok])).toEqual([
      ['Counterparty Check', '0.050000', true],
      ['Wallet Risk Screener', '0.030000', true],
      ['Briefpixel news', '0.010000', true],
    ]);
    expect(v.costUsd).toBe('0.090000');
  });

  it('counts a free signed answer and a failed task without paying', () => {
    const v = parseExecution(withSteps([paid('Briefpixel_news', { data: {}, attestation: {}, payment: null }), paid('Slow_helper', { taskId: 't', status: 'FAILED', error: 'boom', paymentUsd: '0' })]));
    expect(v.helpers.map((h) => [h.name, h.costUsd, h.ok])).toEqual([
      ['Briefpixel news', '0.000000', true],
      ['Slow helper', '0.000000', false],
    ]);
  });

  it('shows a helper that handed back an error text as "did not answer", but only for the agent\'s own helper tools', () => {
    const steps = [{ action: { tool: 'Counterparty_Check' }, observation: 'Agent task failed. Task ID: t1' }, { action: { tool: 'Web_page_reader' }, observation: 'Error: 404' }];
    const v = parseExecution(withSteps(steps), new Set([toolKey('Counterparty Check')]));
    expect(v.helpers).toEqual([{ name: 'Counterparty Check', costUsd: '0.000000', ok: false }]);
  });

  it('reports a run still going without data', () => {
    expect(parseExecution({ execution: { status: 'running' } })).toMatchObject({ status: 'running', helpers: [] });
    expect(parseExecution({ execution: { status: 'new' } }).status).toBe('running');
    expect(parseExecution({ execution: { status: 'waiting' } }).status).toBe('running');
  });

  it('turns a failure into a plain class, never the raw message', () => {
    const failed = (message: string) => parseExecution({ execution: { status: 'error' }, data: { resultData: { runData: {}, error: { message } } } });
    expect(failed('Payment failed: insufficient balance')).toMatchObject({ status: 'error', errorKind: 'credit' });
    expect(failed('The service was not able to process your request (402)').errorKind).toBe('credit');
    expect(failed('Agent task failed. Task ID: abc').errorKind).toBe('helper');
    expect(failed('The operation timed out').errorKind).toBe('timeout');
    expect(failed('Something else entirely').errorKind).toBe('other');
    expect(JSON.stringify(failed('secret detail'))).not.toContain('secret detail');
  });

  it('treats a success with no answer as a failure, and falls back to the AI step\'s own output', () => {
    expect(parseExecution({ execution: { status: 'success' }, data: { resultData: { runData: {} } } })).toMatchObject({ status: 'error', errorKind: 'other' });
    const noAnswerStep = { execution: { status: 'success' }, data: { resultData: { runData: { 'AI step': [{ data: { main: [[{ json: { output: 'From the AI step', intermediateSteps: [] } }]] } }] } } } };
    expect(parseExecution(noAnswerStep)).toMatchObject({ status: 'success', answer: 'From the AI step', reachedAnswer: false });
  });

  it('never throws on junk', () => {
    for (const junk of [null, undefined, 'x', 42, [], {}, { execution: 5 }, { execution: { status: 'success' }, data: 'no' }]) {
      expect(() => parseExecution(junk)).not.toThrow();
    }
    expect(parseExecution(null).status).toBe('error');
  });

  it('reads the question from the Request step', () => {
    expect(parseRequest(REAL)).toBe('Read https://example.com');
    expect(parseRequest({})).toBeUndefined();
  });
});

describe('money and names', () => {
  it('adds in whole micro-dollars with no float drift', () => {
    expect(toMicro('0.05') + toMicro('0.03')).toBe(80_000n);
    expect(fromMicro(toMicro('0.1') + toMicro('0.2'))).toBe('0.300000');
    expect(toMicro('abc')).toBe(0n);
    expect(toMicro(null)).toBe(0n);
    expect(toMicro('-1')).toBe(0n);
    expect(toMicro(0.05)).toBe(50_000n);
    expect(fromMicro(1_234_567n)).toBe('1.234567');
  });
  it('makes tool names readable and comparable', () => {
    expect(toolLabel('Counterparty_Check')).toBe('Counterparty Check');
    expect(toolKey('Counterparty Check')).toBe(toolKey('Counterparty_Check'));
    expect(classifyRunError(undefined)).toBe('other');
  });
});
