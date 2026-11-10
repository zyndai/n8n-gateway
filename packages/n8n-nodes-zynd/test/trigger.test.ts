 
import { describe, expect, it } from 'vitest';
import { ZyndTrigger, safeEqual } from '../nodes/Zynd/ZyndTrigger.node';
import { WEBHOOK_SECRET, makeCtx, type Handler, type Recorded } from './helpers';

const URL_ = 'https://n8n.test/webhook/abc/webhook';
const hooks = new ZyndTrigger().webhookMethods.default;

/** A tiny in-memory Gateway: which listings are bound to which URL. */
function gateway(initial: Record<string, string> = {}) {
	const bound = new Map(Object.entries(initial));
	const log: string[] = [];
	const failOn = new Set<string>();
	const handler: Handler = (req: Recorded) => {
		const path = req.url.replace('https://gw.test/n8n/v1', '');
		log.push(`${req.method} ${path}`);
		if (req.method === 'GET' && path === '/webhooks') {
			const webhooks = [...bound].filter(([, u]) => u === req.qs!.url).map(([id]) => ({ id, listingId: id, url: bound.get(id) }));
			return { statusCode: 200, body: { webhooks } };
		}
		if (req.method === 'POST' && path === '/webhooks') {
			const body = req.body as { listingId: string; url: string; secret: string };
			if (failOn.has(body.listingId)) return { statusCode: 404, body: { error: 'Listing not found', code: 'NOT_FOUND' } };
			bound.set(body.listingId, body.url);
			return { statusCode: 201, body: { id: body.listingId } };
		}
		if (req.method === 'DELETE') {
			const id = decodeURIComponent(path.split('/')[2]!);
			if (!bound.delete(id)) return { statusCode: 404, body: { error: 'Listing not found', code: 'NOT_FOUND' } };
			return { statusCode: 200, body: { id, deleted: true } };
		}
		if (req.method === 'GET' && path === '/listings') return { statusCode: 200, body: { listings: [{ id: 'l1', name: 'Weather', status: 'ACTIVE' }, { id: 'l2', name: 'Traffic', status: 'DRAFT' }] } };
		return { statusCode: 500, body: {} };
	};
	return { bound, log, failOn, handler };
}
const ctx = (params: Record<string, unknown>, gw: ReturnType<typeof gateway>, credentials = {}) =>
	makeCtx(params, { handler: gw.handler, webhookUrl: URL_, credentials }) as never;

describe('ZyndTrigger webhook lifecycle (M3.5, M6.3)', () => {
	it('create binds the listing with the credential secret; checkExists then holds; delete unbinds', async () => {
		const gw = gateway();
		const p = { listingId: 'l1' };
		expect(await hooks.checkExists.call(ctx(p, gw))).toBe(false);
		expect(await hooks.create.call(ctx(p, gw))).toBe(true);
		expect(gw.bound.get('l1')).toBe(URL_);
		const post = makeCtx(p, { handler: gw.handler, webhookUrl: URL_ });
		await hooks.create.call(post as never);
		expect(post.requests[0]!.body).toEqual({ url: URL_, secret: WEBHOOK_SECRET, listingId: 'l1' });
		expect(await hooks.checkExists.call(ctx(p, gw))).toBe(true);
		expect(await hooks.delete.call(ctx(p, gw))).toBe(true);
		expect(gw.bound.size).toBe(0);
	});

	it('several listings: checkExists needs all of them, and releases one taken out of the selection', async () => {
		const gw = gateway({ l1: URL_ });
		const both = { listingId: 'l1', additionalListingIds: ['l2'] };
		expect(await hooks.checkExists.call(ctx(both, gw))).toBe(false); // l2 not bound yet
		await hooks.create.call(ctx(both, gw));
		expect(await hooks.checkExists.call(ctx(both, gw))).toBe(true);
		expect(await hooks.checkExists.call(ctx({ listingId: 'l1' }, gw))).toBe(true);
		expect(gw.bound.has('l2')).toBe(false); // released
	});

	it('a listing selected twice is bound once', async () => {
		const gw = gateway();
		await hooks.create.call(ctx({ listingId: 'l1', additionalListingIds: ['l1'] }, gw));
		expect(gw.log.filter((l) => l.startsWith('POST'))).toHaveLength(1);
	});

	it('create undoes what it bound when a later listing fails', async () => {
		const gw = gateway();
		gw.failOn.add('l2');
		await expect(hooks.create.call(ctx({ listingId: 'l1', additionalListingIds: ['l2'] }, gw))).rejects.toThrow('Listing not found');
		expect(gw.bound.size).toBe(0);
	});

	it('delete also releases other listings bound to the URL, and ignores a listing that is already gone', async () => {
		const gw = gateway({ l9: URL_ });
		expect(await hooks.delete.call(ctx({ listingId: 'l1' }, gw))).toBe(true); // l1 was never bound: 404 is fine
		expect(gw.bound.size).toBe(0);
	});

	it.each([[''], ['short'], [undefined], ['x'.repeat(257)]])('create refuses a Webhook Secret of %j before binding anything', async (secret) => {
		const gw = gateway();
		await expect(hooks.create.call(ctx({ listingId: 'l1' }, gw, { webhookSecret: secret }))).rejects.toThrow('Set a Webhook Secret of 8 to 256 characters');
		expect(gw.log).toEqual([]);
	});

	it('lists the key\'s listings for the picker', async () => {
		const options = await new ZyndTrigger().methods.loadOptions.getListings.call(ctx({}, gateway()));
		expect(options).toEqual([
			{ name: 'Weather (ACTIVE)', value: 'l1' },
			{ name: 'Traffic (DRAFT)', value: 'l2' },
		]);
	});
});

describe('ZyndTrigger incoming jobs (M3.6, M3.7)', () => {
	const job = { jobId: 'j1', listingId: 'l1', entityId: 'zns:x', input: { city: 'Pune' } };
	const run = (headers: Record<string, unknown>, credentials = {}) => {
		const c = makeCtx({}, { headers, body: job, credentials });
		return new ZyndTrigger().webhook.call(c as never).then((out) => ({ out, c }));
	};

	it('starts the workflow with the job when the secret matches', async () => {
		const { out, c } = await run({ 'x-zynd-webhook-secret': WEBHOOK_SECRET });
		expect(out.workflowData).toEqual([[{ json: job }]]);
		expect(c.state.status).toBeUndefined();
	});

	it.each([
		['wrong secret', { 'x-zynd-webhook-secret': 'nope-nope-nope' }],
		['missing header', {}],
		['repeated header', { 'x-zynd-webhook-secret': [WEBHOOK_SECRET, WEBHOOK_SECRET] }],
		['prefix of the secret', { 'x-zynd-webhook-secret': WEBHOOK_SECRET.slice(0, -1) }],
		['secret plus a suffix', { 'x-zynd-webhook-secret': `${WEBHOOK_SECRET}x` }],
	])('%s: empty 401, no execution', async (_name, headers) => {
		const { out, c } = await run(headers);
		expect(out).toEqual({ noWebhookResponse: true });
		expect(c.state).toEqual({ status: 401, ended: true });
	});

	it('an empty credential secret never matches, not even an empty header', async () => {
		const { out, c } = await run({ 'x-zynd-webhook-secret': '' }, { webhookSecret: '' });
		expect(out.workflowData).toBeUndefined();
		expect(c.state.status).toBe(401);
	});

	it('safeEqual', () => {
		expect(safeEqual('abc', 'abc')).toBe(true);
		expect(safeEqual('abc', 'abd')).toBe(false);
		expect(safeEqual('abc', 'abcd')).toBe(false);
		expect(safeEqual('', '')).toBe(true);
		expect(safeEqual('a\u0000', 'a')).toBe(false);
	});

	it('answers per the Respond option: last node (default) or immediately', () => {
		const node = new ZyndTrigger();
		const webhook = node.description.webhooks![0]!;
		expect(webhook.responseMode).toBe('={{$parameter["responseMode"]}}');
		const respond = node.description.properties.find((p) => p.name === 'responseMode')!;
		expect(respond.default).toBe('lastNode');
		expect((respond.options as { value: string }[]).map((o) => o.value)).toEqual(['lastNode', 'onReceived']);
	});
});
