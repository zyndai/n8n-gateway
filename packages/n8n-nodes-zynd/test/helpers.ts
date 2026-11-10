/* eslint-disable @n8n/community-nodes/no-hardcoded-secrets -- tests are not part of the published package */
// A small stand-in for the n8n runtime: just enough context for the nodes to run.
import type { IDataObject } from 'n8n-workflow';

export interface Recorded {
	method: string;
	url: string;
	qs?: IDataObject;
	body?: unknown;
	timeout?: number;
}
export type Handler = (req: Recorded) => { statusCode: number; body?: unknown } | Promise<{ statusCode: number; body?: unknown }>;

export const API_KEY = 'zk_test_KEY_0123456789';
export const WEBHOOK_SECRET = 'whsec_test_0123456789';

export interface CtxOptions {
	credentials?: Record<string, unknown>;
	handler?: Handler;
	items?: IDataObject[];
	continueOnFail?: boolean;
	headers?: Record<string, unknown>;
	body?: IDataObject;
	webhookUrl?: string;
}

export function makeCtx(params: Record<string, unknown>, opts: CtxOptions = {}) {
	const requests: Recorded[] = [];
	const state: { status?: number; ended: boolean } = { ended: false };
	const credentials = { apiUrl: 'https://gw.test/', apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, ...opts.credentials };
	const ctx = {
		requests,
		state,
		getNode: () => ({ id: 'n1', name: 'Zynd', type: 'n8n-nodes-zynd.zynd', typeVersion: 1, position: [0, 0], parameters: {} }),
		getCredentials: async () => credentials,
		getInputData: () => (opts.items ?? [{}]).map((json) => ({ json })),
		getNodeParameter: (name: string, ...rest: unknown[]) => (name in params ? params[name] : typeof rest[0] === 'number' ? rest[1] : rest[0]),
		continueOnFail: () => opts.continueOnFail ?? false,
		getNodeWebhookUrl: () => opts.webhookUrl ?? 'https://n8n.test/webhook/abc/webhook',
		getHeaderData: () => opts.headers ?? {},
		getBodyData: () => opts.body ?? {},
		getResponseObject: () => {
			const res = {
				status: (code: number) => {
					state.status = code;
					return res;
				},
				end: () => {
					state.ended = true;
					return res;
				},
			};
			return res;
		},
		helpers: {
			httpRequestWithAuthentication: async (_credential: string, o: Recorded) => {
				const rec: Recorded = { method: o.method, url: o.url, qs: o.qs, body: o.body, timeout: o.timeout };
				requests.push(rec);
				return (opts.handler ?? (() => ({ statusCode: 200, body: {} })))(rec);
			},
		},
	};
	return ctx;
}
