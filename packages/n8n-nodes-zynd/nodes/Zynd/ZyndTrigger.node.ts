import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { CREDENTIAL, gatewayRequest } from './gateway';

interface Listing {
	id: string;
	name: string;
	status: string;
}
interface Webhook {
	id: string;
	listingId: string;
}

const SECRET_HEADER = 'x-zynd-webhook-secret';

/** Compares without stopping at the first difference, so timing does not reveal how much matched. */
export function safeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	return diff === 0;
}

/** The main listing first, then the extra ones, without repeats. */
function selectedListings(ctx: IHookFunctions): string[] {
	const main = ctx.getNodeParameter('listingId', '') as string;
	const extra = ctx.getNodeParameter('additionalListingIds', []) as string[];
	return [...new Set([main, ...extra].filter((id) => typeof id === 'string' && id !== ''))];
}

function webhookUrl(ctx: IHookFunctions): string {
	const url = ctx.getNodeWebhookUrl('default');
	if (!url) throw new NodeOperationError(ctx.getNode(), 'Could not work out this workflow\'s webhook URL');
	return url;
}

async function boundTo(ctx: IHookFunctions, url: string): Promise<Webhook[]> {
	const { body } = await gatewayRequest<{ webhooks?: Webhook[] }>(ctx, { method: 'GET', path: '/webhooks', qs: { url }, notFound: 'Listing' });
	return body?.webhooks ?? [];
}

const unbind = (ctx: IHookFunctions, listingId: string) =>
	gatewayRequest(ctx, { method: 'DELETE', path: `/webhooks/${encodeURIComponent(listingId)}`, allow: [404], notFound: 'Listing' });

export class ZyndTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Zynd Trigger',
		name: 'zyndTrigger',
		icon: { light: 'file:zynd.svg', dark: 'file:zynd.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: 'Paid jobs',
		description: 'Starts the workflow when another agent sends a job to your Zynd listing',
		defaults: { name: 'Zynd Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: '={{$parameter["responseMode"]}}',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Listing Name or ID',
				name: 'listingId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getListings' },
				default: '',
				required: true,
				description:
					'The listing this workflow serves. Activating the workflow makes it live. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Additional Listing Names or IDs',
				name: 'additionalListingIds',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getListings' },
				default: [],
				description:
					'Serve more listings with this one workflow. Each job says which listing it was for in the field listingId. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Respond',
				name: 'responseMode',
				type: 'options',
				default: 'lastNode',
				options: [
					{
						name: 'When Last Node Finishes',
						value: 'lastNode',
						description:
							'The caller waits for the result. The last node must output a field called output, which becomes the answer.',
					},
					{
						name: 'Immediately',
						value: 'onReceived',
						description: 'Accept the job at once. Finish it later with the Zynd node, operation Complete Job.',
					},
				],
				description: 'When to answer the Gateway',
			},
		],
	};

	methods = {
		loadOptions: {
			async getListings(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const { body } = await gatewayRequest<{ listings?: Listing[] }>(this, { method: 'GET', path: '/listings' });
				return (body?.listings ?? []).map((l) => ({ name: `${l.name} (${l.status})`, value: l.id }));
			},
		},
	};

	webhookMethods = {
		default: {
			/**
			 * True only when every selected listing is bound to this workflow's URL. Anything else bound
			 * to the URL (a listing taken out of the selection) is released.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const selected = selectedListings(this);
				const bound = await boundTo(this, webhookUrl(this));
				for (const hook of bound) {
					if (!selected.includes(hook.listingId)) await unbind(this, hook.listingId);
				}
				return selected.length > 0 && selected.every((id) => bound.some((hook) => hook.listingId === id));
			},

			/** Binds each selected listing in order; if one fails, undoes the ones this call bound. */
			async create(this: IHookFunctions): Promise<boolean> {
				const url = webhookUrl(this);
				const { webhookSecret } = await this.getCredentials(CREDENTIAL);
				if (typeof webhookSecret !== 'string' || webhookSecret.length < 8 || webhookSecret.length > 256) {
					throw new NodeOperationError(this.getNode(), 'Set a Webhook Secret of 8 to 256 characters in the Zynd credential', {
						description: 'The Gateway sends it with every job and the trigger drops jobs that do not carry it.',
					});
				}
				const bound: string[] = [];
				let failure: unknown;
				try {
					for (const listingId of selectedListings(this)) {
						await gatewayRequest<IDataObject>(this, {
							method: 'POST',
							path: '/webhooks',
							body: { url, secret: webhookSecret, listingId },
							notFound: 'Listing',
						});
						bound.push(listingId);
					}
				} catch (error) {
					failure = error;
				}
				if (failure !== undefined) {
					// Undo what this call bound, then report the original failure (already a NodeApiError).
					for (const listingId of bound) await unbind(this, listingId).catch(() => undefined);
					throw failure;
				}
				return true;
			},

			/** Unbinds every selected listing and anything else still bound to this URL. A listing that is gone is fine. */
			async delete(this: IHookFunctions): Promise<boolean> {
				const ids = new Set(selectedListings(this));
				for (const hook of await boundTo(this, webhookUrl(this))) ids.add(hook.listingId);
				for (const listingId of ids) await unbind(this, listingId);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const { webhookSecret } = await this.getCredentials(CREDENTIAL);
		const sent = this.getHeaderData()[SECRET_HEADER];
		const expected = typeof webhookSecret === 'string' ? webhookSecret : '';

		// Wrong, missing or repeated header, or no secret configured: answer with an empty 401 and start nothing.
		if (!expected || typeof sent !== 'string' || !safeEqual(sent, expected)) {
			this.getResponseObject().status(401).end();
			return { noWebhookResponse: true };
		}
		return { workflowData: [[{ json: this.getBodyData() as IDataObject }]] };
	}
}
