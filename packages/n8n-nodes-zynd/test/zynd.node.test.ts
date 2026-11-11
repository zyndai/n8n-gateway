 
import { describe, expect, it } from 'vitest';
import { ZyndApi } from '../credentials/ZyndApi.credentials';
import { Zynd } from '../nodes/Zynd/Zynd.node';
import { ZyndAirnode } from '../nodes/Zynd/ZyndAirnode.node';
import { makeCtx, type Handler } from './helpers';

const exec = (params: Record<string, unknown>, handler: Handler, items?: Record<string, unknown>[]) => {
	const ctx = makeCtx(params, { handler, items: items as never });
	return new Zynd().execute.call(ctx as never).then((out) => ({ out: out[0]!, ctx }));
};
const ok = (body: unknown) => () => ({ statusCode: 200, body });

describe('Zynd node operations (M3.2)', () => {
	it('Search Agents: one item per result, only non-empty filters are sent', async () => {
		const { out, ctx } = await exec(
			{ operation: 'searchAgents', query: ' weather ', category: '', limit: 5, offset: 10 },
			ok({ results: [{ entity_id: 'zns:1' }, { entity_id: 'zns:2' }], total_found: 2, offset: 10, has_more: false }),
		);
		expect(out.map((i) => i.json.entity_id)).toEqual(['zns:1', 'zns:2']);
		expect(ctx.requests).toEqual([{ method: 'GET', url: 'https://gw.test/n8n/v1/agents', qs: { limit: 5, offset: 10, q: 'weather' }, body: undefined, timeout: 60_000 }]);
	});

	it('Search Agents sends the category when set, and a result-less answer gives no items', async () => {
		const { out, ctx } = await exec({ operation: 'searchAgents', query: '', category: 'finance', limit: 50, offset: 0 }, ok({ results: [] }));
		expect(out).toEqual([]);
		expect(ctx.requests[0]!.qs).toEqual({ limit: 50, offset: 0, category: 'finance' });
	});

	it('Call Agent: text input, a spend cap, the 310 s wait, and the id is URL-encoded', async () => {
		const task = { taskId: 't1', status: 'COMPLETED', output: { a: 1 }, error: null, paymentUsd: '0.050000', paymentTxn: '0xabc' };
		const { out, ctx } = await exec({ operation: 'callAgent', agentId: 'zns:abc', inputType: 'text', inputText: 'hello', maxPaymentUsd: '0.05' }, ok(task));
		expect(out[0]!.json).toEqual(task);
		expect(ctx.requests[0]).toMatchObject({ method: 'POST', url: 'https://gw.test/n8n/v1/agents/zns%3Aabc/tasks', body: { input: 'hello', maxPaymentUsd: '0.05' }, timeout: 310_000 });
	});

	it('Call Agent: Pay From Listing Wallet sends the listing id', async () => {
		const { ctx } = await exec({ operation: 'callAgent', agentId: 'zns:a', inputType: 'text', inputText: 'x', payFrom: 'listing', payFromListingId: ' lst-9 ' }, ok({ taskId: 't', status: 'COMPLETED', output: 1, error: null }));
		expect(ctx.requests[0]!.body).toEqual({ input: 'x', payFromListingId: 'lst-9' });
	});

	it('Call Agent: JSON input is parsed, an empty cap is left out', async () => {
		const { ctx } = await exec({ operation: 'callAgent', agentId: 'zns:a', inputType: 'json', inputJson: '{"q":[1,2]}', maxPaymentUsd: ' ' }, ok({ taskId: 't', status: 'COMPLETED', output: 1, error: null }));
		expect(ctx.requests[0]!.body).toEqual({ input: { q: [1, 2] } });
	});

	it('Call Agent: an object from an expression is sent as is', async () => {
		const { ctx } = await exec({ operation: 'callAgent', agentId: 'zns:a', inputType: 'json', inputJson: { q: 1 }, maxPaymentUsd: '' }, ok({ taskId: 't', status: 'COMPLETED', output: 1, error: null }));
		expect(ctx.requests[0]!.body).toEqual({ input: { q: 1 } });
	});

	it.each([['abc'], ['-1'], ['0.1234567'], ['1e3']])('Call Agent rejects the cap %s before any request', async (cap) => {
		const ctx = makeCtx({ operation: 'callAgent', agentId: 'zns:a', inputType: 'text', inputText: 'x', maxPaymentUsd: cap });
		await expect(new Zynd().execute.call(ctx as never)).rejects.toThrow('Max Payment must be an amount in USD');
		expect(ctx.requests).toHaveLength(0);
	});

	it('Call Agent rejects invalid input JSON and a missing agent', async () => {
		await expect(exec({ operation: 'callAgent', agentId: 'zns:a', inputType: 'json', inputJson: '{nope', maxPaymentUsd: '' }, ok({}))).rejects.toThrow('Input (JSON) is not valid JSON');
		await expect(exec({ operation: 'callAgent', agentId: ' ', inputType: 'text', inputText: 'x', maxPaymentUsd: '' }, ok({}))).rejects.toThrow('Agent ID is required');
	});

	it.each([['FAILED'], ['TIMEOUT'], ['CANCELED']])('Call Agent throws when the task ends %s', async (status) => {
		const err = await exec({ operation: 'callAgent', agentId: 'zns:a', inputType: 'text', inputText: 'x', maxPaymentUsd: '' }, ok({ taskId: 'tt', status, output: null, error: 'agent said no' })).catch((e) => e);
		expect(err.message).toBe(`Agent task ${status.toLowerCase()}`);
		expect(err.description).toBe('agent said no. Task ID: tt');
	});

	it('Get Task reads the task', async () => {
		const { out, ctx } = await exec({ operation: 'getTask', taskId: 'a b' }, ok({ taskId: 'a b', status: 'PROCESSING' }));
		expect(out[0]!.json).toMatchObject({ status: 'PROCESSING' });
		expect(ctx.requests[0]).toMatchObject({ method: 'GET', url: 'https://gw.test/n8n/v1/tasks/a%20b' });
	});

	it('Complete Job: success sends the parsed output, failure sends the error', async () => {
		const done = ok({ jobId: 'j1', status: 'COMPLETED' });
		const success = await exec({ operation: 'completeJob', jobId: 'j1', outcome: 'success', output: '{"x":[1]}' }, done);
		expect(success.ctx.requests[0]).toMatchObject({ method: 'POST', url: 'https://gw.test/n8n/v1/jobs/j1/complete', body: { output: { x: [1] } } });
		const text = await exec({ operation: 'completeJob', jobId: 'j1', outcome: 'success', output: '"plain"' }, done);
		expect(text.ctx.requests[0]!.body).toEqual({ output: 'plain' });
		const failure = await exec({ operation: 'completeJob', jobId: 'j1', outcome: 'failure', errorMessage: '  ' }, ok({ jobId: 'j1', status: 'FAILED' }));
		expect(failure.ctx.requests[0]!.body).toEqual({ error: 'The workflow failed' });
		expect(failure.out[0]!.json).toEqual({ jobId: 'j1', status: 'FAILED' });
	});

	it('Complete Job rejects invalid output JSON and a missing job id', async () => {
		await expect(exec({ operation: 'completeJob', jobId: 'j', outcome: 'success', output: 'not json' }, ok({}))).rejects.toThrow('Output is not valid JSON');
		await expect(exec({ operation: 'completeJob', jobId: '', outcome: 'success', output: '1' }, ok({}))).rejects.toThrow('Job ID is required');
	});

	it('List Listings: one item per listing', async () => {
		const { out } = await exec({ operation: 'listListings' }, ok({ listings: [{ id: 'l1' }, { id: 'l2' }] }));
		expect(out.map((i) => i.json.id)).toEqual(['l1', 'l2']);
	});

	it('runs once per input item and pairs outputs with their input', async () => {
		const { out, ctx } = await exec({ operation: 'listListings' }, ok({ listings: [{ id: 'l1' }] }), [{}, {}]);
		expect(ctx.requests).toHaveLength(2);
		expect(out.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('rejects an API URL that is not http(s), and trims trailing slashes from a good one', async () => {
		const bad = makeCtx({ operation: 'listListings' }, { credentials: { apiUrl: 'gw.zynd.ai' } });
		await expect(new Zynd().execute.call(bad as never)).rejects.toThrow('must start with http');
		const good = makeCtx({ operation: 'listListings' }, { credentials: { apiUrl: 'https://gw.test///' }, handler: ok({ listings: [] }) });
		await new Zynd().execute.call(good as never);
		expect(good.requests[0]!.url).toBe('https://gw.test/n8n/v1/listings');
	});

	it('is usable as an AI agent tool and declares the credential', () => {
		const node = new Zynd();
		expect(node.description.usableAsTool).toBe(true);
		expect(node.description.credentials).toEqual([{ name: 'zyndApi', required: true }]);
	});
});

describe('ZyndApi credential (M3.1)', () => {
	const cred = new ZyndApi();
	it('injects X-Zynd-Api-Key and tests against the listings route', () => {
		expect(cred.name).toBe('zyndApi');
		expect(cred.authenticate.properties).toEqual({ headers: { 'X-Zynd-Api-Key': '={{$credentials.apiKey}}' } });
		expect(cred.test.request).toEqual({ baseURL: '={{$credentials.apiUrl}}', url: '/n8n/v1/listings' });
	});
	it('masks the key and the webhook secret and defaults the URL', () => {
		const field = (name: string) => cred.properties.find((p) => p.name === name)!;
		expect(field('apiUrl').default).toBe('https://gw.zynd.ai');
		expect(field('apiKey').typeOptions).toEqual({ password: true });
		expect(field('webhookSecret').typeOptions).toEqual({ password: true });
	});
});

describe('Zynd AirnodeHub node (Zynd x AirnodeHub showcase)', () => {
	const run = (params: Record<string, unknown>, handler: Handler) => {
		const ctx = makeCtx(params, { handler });
		return new ZyndAirnode().execute.call(ctx as never).then((out) => ({ out: out[0]!, ctx }));
	};
	const verified = { verified: true, requestHashMatches: true, signer: '0xabc', expectedSigner: '0xabc' };
	const answer = { listingUrl: 'https://airnode-gleif.fly.dev/', operation: 'getLegalEntity', data: { lei: 'X' }, attestation: { airnode: '0xabc' }, verification: verified, payment: null };
	const base = { operation: 'call', listingUrl: 'https://airnode-gleif.fly.dev/', airnodeOperation: 'getLegalEntity', airnodeParameters: '{}' };

	it('Call: sends listing, operation, parsed parameters, cap and the paying listing', async () => {
		const { out, ctx } = await run({ ...base, listingUrl: ' https://airnode-gleif.fly.dev/ ', airnodeParameters: '{"lei":"X"}', maxPaymentUsd: '0.02', payFrom: 'listing', payFromListingId: 'lst-1', failIfUnverified: true }, ok(answer));
		expect(out[0]!.json).toEqual(answer);
		expect(ctx.requests[0]).toMatchObject({
			method: 'POST',
			url: 'https://gw.test/n8n/v1/airnode/call',
			body: { listingUrl: 'https://airnode-gleif.fly.dev/', operation: 'getLegalEntity', parameters: { lei: 'X' }, maxPaymentUsd: '0.02', payFromListingId: 'lst-1' },
			timeout: 90_000,
		});
	});

	it('Call: the developer wallet sends no listing id, an expression object is sent as is, an empty cap is left out', async () => {
		const { ctx } = await run({ ...base, airnodeOperation: 'searchLegalEntities', airnodeParameters: { q: 1 }, maxPaymentUsd: '', payFrom: 'developer' }, ok(answer));
		expect(ctx.requests[0]!.body).toEqual({ listingUrl: 'https://airnode-gleif.fly.dev/', operation: 'searchLegalEntities', parameters: { q: 1 } });
	});

	it('Call: an unverified answer fails by default, or passes through when allowed', async () => {
		const bad = { ...answer, verification: { verified: false, reason: 'The signature was not made by the address this listing publishes' } };
		await expect(run(base, ok(bad))).rejects.toThrow(/failed signature verification/);
		const { out } = await run({ ...base, failIfUnverified: false }, ok(bad));
		expect(out[0]!.json.verification).toMatchObject({ verified: false });
	});

	it('Call rejects a bad listing URL, a missing operation, non-object parameters and a bad cap', async () => {
		await expect(run({ ...base, listingUrl: 'http://airnode-gleif.fly.dev/' }, ok(answer))).rejects.toThrow(/Listing URL/);
		await expect(run({ ...base, airnodeOperation: ' ' }, ok(answer))).rejects.toThrow(/Airnode Operation/);
		await expect(run({ ...base, airnodeParameters: '[1]' }, ok(answer))).rejects.toThrow(/JSON object/);
		await expect(run({ ...base, maxPaymentUsd: 'lots' }, ok(answer))).rejects.toThrow(/Max Payment/);
	});

	it('Verify posts the kept attestation', async () => {
		const att = { airnode: '0xabc', requestHash: '0x1', timestamp: '1', data: '{}', signature: '0x2' };
		const { out, ctx } = await run({ ...base, operation: 'verify', airnodeParameters: '{"lei":"X"}', attestation: JSON.stringify(att) }, ok(verified));
		expect(out[0]!.json).toEqual(verified);
		expect(ctx.requests[0]).toMatchObject({ url: 'https://gw.test/n8n/v1/airnode/verify', body: { listingUrl: 'https://airnode-gleif.fly.dev/', operation: 'getLegalEntity', parameters: { lei: 'X' }, attestation: att } });
	});
});
