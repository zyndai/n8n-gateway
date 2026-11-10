 
import { describe, expect, it } from 'vitest';
import { Zynd } from '../nodes/Zynd/Zynd.node';
import { API_KEY, WEBHOOK_SECRET, makeCtx } from './helpers';

const run = (params: Record<string, unknown>, status: number, body: unknown) =>
	new Zynd().execute.call(makeCtx(params, { handler: () => ({ statusCode: status, body }) }) as never);

const callParams = { operation: 'callAgent', agentId: 'zns:a', inputType: 'text', inputText: 'hi', maxPaymentUsd: '' };

describe('Gateway errors map to the LLD messages (M3.4)', () => {
	const table: [string, number, string, string?][] = [
		['AUTH_INVALID', 401, 'Invalid API key'],
		['AUTH_EXPIRED', 401, 'API key expired'],
		['RATE_LIMITED', 429, 'Rate limit exceeded'],
		['PAYMENT_CAP', 402, 'Spend cap exceeded'],
		['LISTING_INACTIVE', 409, 'Listing is not active'],
		['TASK_TIMEOUT', 504, 'Task timed out after 300 s'],
		['GATEWAY_UNAVAILABLE', 502, 'Gateway unavailable'],
		['PAYMENT_FAILED', 402, 'Payment failed'],
	];
	for (const [code, status, message] of table) {
		it(`${code} -> ${message}`, async () => {
			await expect(run(callParams, status, { error: 'text from the gateway', code })).rejects.toThrow(message);
		});
	}

	it('AUTH_FORBIDDEN names the missing permission', async () => {
		await expect(run(callParams, 403, { error: 'API key lacks the "call" permission', code: 'AUTH_FORBIDDEN' })).rejects.toThrow('Requires permission call');
	});

	it('NOT_FOUND reads per operation', async () => {
		const notFound = { error: 'Not found', code: 'NOT_FOUND' };
		await expect(run(callParams, 404, notFound)).rejects.toThrow('Agent not found');
		await expect(run({ operation: 'getTask', taskId: 't' }, 404, notFound)).rejects.toThrow('Task not found');
		await expect(run({ operation: 'completeJob', jobId: 'j', outcome: 'success', output: '1' }, 404, notFound)).rejects.toThrow('Job not found');
	});

	it('RATE_LIMITED says when to retry', async () => {
		const err = await run(callParams, 429, { error: 'x', code: 'RATE_LIMITED', details: { retryAfterSec: 7 } }).catch((e) => e);
		expect(err.description).toBe('Retry in 7 s.');
	});

	it('an unknown error keeps the Gateway text and status', async () => {
		const err = await run(callParams, 418, { error: 'I am a teapot', code: 'TEAPOT' }).catch((e) => e);
		expect(err.message).toBe('I am a teapot');
		expect(err.httpCode).toBe('418');
	});

	it('a body that is not JSON still produces an error', async () => {
		await expect(run(callParams, 502, '<html>bad gateway</html>')).rejects.toThrow('The Gateway answered HTTP 502');
	});

	it('an unreachable Gateway reads "Gateway unavailable"', async () => {
		const ctx = makeCtx(callParams, {
			handler: () => {
				throw Object.assign(new Error(`connect ECONNREFUSED with key ${API_KEY}`), { code: 'ECONNREFUSED' });
			},
		});
		const err = await new Zynd().execute.call(ctx as never).catch((e) => e);
		expect(err.message).toBe('Gateway unavailable');
		expect(err.description).toContain('ECONNREFUSED');
	});

	it('the API key and webhook secret never appear in an error (M3.9)', async () => {
		const bodies = [
			{ error: 'Invalid API key', code: 'AUTH_INVALID' },
			{ error: 'boom', code: 'INTERNAL', details: { reason: 'x' } },
			'plain text',
		];
		for (const body of bodies) {
			const err = await run(callParams, 401, body).catch((e) => e);
			const text = JSON.stringify(err, Object.getOwnPropertyNames(err));
			expect(text).not.toContain(API_KEY);
			expect(text).not.toContain(WEBHOOK_SECRET);
		}
		const down = await new Zynd()
			.execute.call(makeCtx(callParams, { handler: () => { throw new Error(`secret ${API_KEY}`); } }) as never)
			.catch((e) => e);
		expect(JSON.stringify(down, Object.getOwnPropertyNames(down))).not.toContain(API_KEY);
	});

	it('continueOnFail turns an error into an item', async () => {
		const ctx = makeCtx(callParams, { continueOnFail: true, handler: () => ({ statusCode: 401, body: { error: 'x', code: 'AUTH_INVALID' } }) });
		const [out] = await new Zynd().execute.call(ctx as never);
		expect(out).toEqual([{ json: { error: 'Invalid API key' }, pairedItem: { item: 0 } }]);
	});
});
