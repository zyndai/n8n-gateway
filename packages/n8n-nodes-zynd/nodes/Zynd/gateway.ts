import type {
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IDataObject,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export const CREDENTIAL = 'zyndApi';

/** Anything with the credential and HTTP helpers: action node, hooks and the option loaders. */
export type GatewayContext = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

/** What a 404 means for the call being made. */
export type NotFoundSubject = 'Agent' | 'Task' | 'Job' | 'Listing';

export interface GatewayRequest {
	method: IHttpRequestMethods;
	/** Path under `/n8n/v1`, starting with a slash. */
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	timeoutMs?: number;
	notFound?: NotFoundSubject;
	/** Extra non-2xx statuses that are returned instead of thrown (for example 404 on delete). */
	allow?: number[];
	itemIndex?: number;
}

export interface GatewayResponse<T> {
	status: number;
	body: T;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Joins the credential's API URL with the Gateway's `/n8n/v1` prefix. */
function baseUrl(node: INode, apiUrl: unknown): string {
	const url = typeof apiUrl === 'string' ? apiUrl.trim().replace(/\/+$/, '') : '';
	if (!/^https?:\/\/\S+$/i.test(url)) {
		throw new NodeOperationError(node, 'The API URL in the Zynd credential must start with http:// or https://');
	}
	return `${url}/n8n/v1`;
}

/** Calls the Gateway through n8n's authenticated helper and maps every failure to a NodeApiError. */
export async function gatewayRequest<T = unknown>(ctx: GatewayContext, req: GatewayRequest): Promise<GatewayResponse<T>> {
	const node = ctx.getNode();
	const credentials = await ctx.getCredentials(CREDENTIAL);
	const options: IHttpRequestOptions = {
		method: req.method,
		url: `${baseUrl(node, credentials.apiUrl)}${req.path}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		timeout: req.timeoutMs ?? 60_000,
	};
	if (req.qs) options.qs = req.qs;
	if (req.body) options.body = req.body;

	let response: { statusCode?: number; body?: unknown };
	try {
		response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, options)) as typeof response;
	} catch (error) {
		throw unreachable(node, error, req.itemIndex);
	}

	const status = response.statusCode ?? 0;
	if ((status >= 200 && status < 300) || req.allow?.includes(status)) {
		return { status, body: response.body as T };
	}
	throw gatewayError(node, status, response.body, req.notFound, req.itemIndex);
}

/** The Gateway could not be reached at all (DNS, refused, timed out). Built from the error code only. */
function unreachable(node: INode, error: unknown, itemIndex?: number): NodeApiError {
	const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
	const reason = code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'ESOCKETTIMEDOUT' ? 'The request timed out' : code ? `Connection failed (${code})` : 'Connection failed';
	return new NodeApiError(node, { code: 'GATEWAY_UNAVAILABLE', error: reason } as JsonObject, {
		message: 'Gateway unavailable',
		description: `${reason}. Check the API URL in the Zynd credential and that the Gateway is running.`,
		httpCode: '502',
		itemIndex,
	});
}

const NOT_FOUND_MESSAGE: Record<NotFoundSubject, string> = {
	Agent: 'Agent not found',
	Task: 'Task not found',
	Job: 'Job not found',
	Listing: 'Listing not found',
};

/**
 * Maps a Gateway `{ error, code, details? }` body to the messages in the LLD error table. The
 * Gateway's own text becomes the description. Only the status and that body are used, never the
 * request, so no credential can end up in the error.
 */
export function gatewayError(node: INode, status: number, body: unknown, notFound?: NotFoundSubject, itemIndex?: number): NodeApiError {
	const b = isRecord(body) ? body : {};
	const text = typeof b.error === 'string' ? b.error : undefined;
	const code = typeof b.code === 'string' ? b.code : undefined;
	const details = isRecord(b.details) ? b.details : {};

	let message: string;
	switch (code) {
		case 'AUTH_INVALID':
			message = 'Invalid API key';
			break;
		case 'AUTH_EXPIRED':
			message = 'API key expired';
			break;
		case 'RATE_LIMITED':
			message = 'Rate limit exceeded';
			break;
		case 'AUTH_FORBIDDEN': {
			const permission = text?.match(/"([a-z]+)" permission/)?.[1];
			message = permission ? `Requires permission ${permission}` : 'Permission denied';
			break;
		}
		case 'PAYMENT_CAP':
			message = 'Spend cap exceeded';
			break;
		case 'PAYMENT_FAILED':
			message = 'Payment failed';
			break;
		case 'NOT_FOUND':
			message = notFound ? NOT_FOUND_MESSAGE[notFound] : 'Not found';
			break;
		case 'LISTING_INACTIVE':
			message = 'Listing is not active';
			break;
		case 'TASK_TIMEOUT':
			message = 'Task timed out after 300 s';
			break;
		case 'GATEWAY_UNAVAILABLE':
			message = 'Gateway unavailable';
			break;
		default:
			message = status === 404 && notFound ? NOT_FOUND_MESSAGE[notFound] : (text ?? `The Gateway answered HTTP ${status}`);
	}

	let description = text && text !== message ? text : undefined;
	if (code === 'RATE_LIMITED' && typeof details.retryAfterSec === 'number') {
		description = `Retry in ${details.retryAfterSec} s.`;
	}

	const safeBody: JsonObject = { error: text ?? message };
	if (code) safeBody.code = code;
	if (b.details !== undefined) safeBody.details = b.details as JsonObject;
	return new NodeApiError(node, safeBody, { message, description, httpCode: String(status), itemIndex });
}
