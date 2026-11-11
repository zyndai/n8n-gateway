import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { CREDENTIAL, gatewayRequest } from './gateway';

type Operation = 'call' | 'verify';

/** A decimal USD amount with at most 6 decimals, the Gateway's limit. */
const USD = /^\d+(\.\d{1,6})?$/;

/** An AirnodeHub listing root, e.g. https://airnode-gleif.fly.dev/ (the Gateway enforces the allow-list). */
const LISTING_URL = /^https:\/\/[a-z0-9.-]+\/?$/;

interface CallResult extends IDataObject {
	verification?: { verified?: boolean; reason?: string };
}

/**
 * Signed data from AirnodeHub, through the Zynd Gateway. n8n cannot sign x402, so the Gateway pays
 * priced operations in aUSD from a wallet it holds and checks each response's signature against the
 * address the listing publishes. The result keeps the attestation, so anyone can re-check it later.
 */
export class ZyndAirnode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Zynd AirnodeHub',
		name: 'zyndAirnode',
		icon: { light: 'file:zynd.svg', dark: 'file:zynd.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["airnodeOperation"]}}',
		description: 'Fetch signed data from AirnodeHub, paid per call through your Zynd account, and verify it',
		defaults: { name: 'AirnodeHub' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'call',
				options: [
					{
						name: 'Call',
						value: 'call',
						action: 'Call an operation',
						description: 'Fetch signed data from a listing. Priced operations are paid in aUSD over x402 by the Gateway, and the signature is checked.',
					},
					{
						name: 'Verify',
						value: 'verify',
						action: 'Verify an attestation',
						description: 'Check that kept data is exactly what the listing signed. Free.',
					},
				],
			},
			{
				displayName: 'Listing URL',
				name: 'listingUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://airnode-gleif.fly.dev/',
				description: 'The AirnodeHub listing root. Open it in a browser to see its operations and prices.',
			},
			{
				displayName: 'Airnode Operation',
				name: 'airnodeOperation',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'getLegalEntity',
				description: 'The operation name from the listing\'s documentation',
			},
			{
				displayName: 'Parameters (JSON)',
				name: 'airnodeParameters',
				type: 'json',
				default: '{}',
				required: true,
				description: 'The operation\'s parameters. For Verify, the exact parameters of the original call.',
			},
			{
				displayName: 'Max Payment (USD)',
				name: 'maxPaymentUsd',
				type: 'string',
				default: '',
				placeholder: '0.01',
				description: 'The most you are willing to pay for this call, in USD (up to 6 decimals). The call fails if it costs more. Leave empty to use the Gateway default.',
				displayOptions: { show: { operation: ['call'] } },
			},
			{
				displayName: 'Pay From',
				name: 'payFrom',
				type: 'options',
				default: 'developer',
				options: [
					{ name: 'Developer Wallet', value: 'developer', description: 'Your Zynd account\'s payer wallet' },
					{ name: 'Listing Wallet', value: 'listing', description: 'The wallet of one of your listings, so an agent spends what it earns' },
				],
				description: 'Which wallet pays a priced operation',
				displayOptions: { show: { operation: ['call'] } },
			},
			{
				displayName: 'Listing ID',
				name: 'payFromListingId',
				type: 'string',
				default: '={{ $json.listingId }}',
				required: true,
				description: 'The listing whose wallet pays. The Zynd Trigger puts it in the field listingId.',
				displayOptions: { show: { operation: ['call'], payFrom: ['listing'] } },
			},
			{
				displayName: 'Fail If Unverified',
				name: 'failIfUnverified',
				type: 'boolean',
				default: true,
				description: 'Whether to stop with an error when the signature does not check out, instead of returning the data marked unverified',
				displayOptions: { show: { operation: ['call'] } },
			},
			{
				displayName: 'Attestation (JSON)',
				name: 'attestation',
				type: 'json',
				default: '{}',
				required: true,
				description: 'The attestation returned by Call: airnode, requestHash, timestamp, data and signature',
				displayOptions: { show: { operation: ['verify'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			let failure: unknown;
			try {
				const operation = this.getNodeParameter('operation', i, 'call') as Operation;
				out.push({ json: await run(this, operation, i), pairedItem: { item: i } });
			} catch (error) {
				failure = error;
			}
			if (failure === undefined) continue;
			if (this.continueOnFail()) {
				out.push({ json: { error: failure instanceof Error ? failure.message : String(failure) }, pairedItem: { item: i } });
				continue;
			}
			// Already a NodeApiError / NodeOperationError (every failure path builds one): just add the item index.
			const context = (failure as { context?: IDataObject }).context;
			if (context && typeof context === 'object') context.itemIndex = i;
			throw failure;
		}
		return [out];
	}
}

async function run(ctx: IExecuteFunctions, operation: Operation, i: number): Promise<IDataObject> {
	const request = airnodeRequest(ctx, i);
	if (operation === 'verify') {
		const attestation = parseJson(ctx, ctx.getNodeParameter('attestation', i, '{}'), 'Attestation (JSON)', i);
		const { body } = await gatewayRequest<IDataObject>(ctx, { method: 'POST', path: '/airnode/verify', body: { ...request, attestation: attestation as IDataObject }, itemIndex: i });
		return body;
	}
	if (operation !== 'call') throw new NodeOperationError(ctx.getNode(), `Unknown operation: ${String(operation)}`, { itemIndex: i });

	const body: IDataObject = { ...request };
	const max = String(ctx.getNodeParameter('maxPaymentUsd', i, '') ?? '').trim();
	if (max) {
		if (!USD.test(max)) throw new NodeOperationError(ctx.getNode(), 'Max Payment must be an amount in USD such as 0.01 (up to 6 decimals)', { itemIndex: i });
		body.maxPaymentUsd = max;
	}
	if (ctx.getNodeParameter('payFrom', i, 'developer') === 'listing') {
		const listingId = String(ctx.getNodeParameter('payFromListingId', i, '') ?? '').trim();
		if (!listingId) throw new NodeOperationError(ctx.getNode(), 'Listing ID is required to pay from a listing wallet', { itemIndex: i });
		body.payFromListingId = listingId;
	}
	const res = await gatewayRequest<CallResult>(ctx, { method: 'POST', path: '/airnode/call', body, timeoutMs: 90_000, itemIndex: i });
	if (ctx.getNodeParameter('failIfUnverified', i, true) && res.body.verification?.verified !== true) {
		throw new NodeOperationError(ctx.getNode(), 'AirnodeHub response failed signature verification', {
			itemIndex: i,
			description: res.body.verification?.reason ?? 'The signature did not check out',
		});
	}
	return res.body;
}

/** Listing URL, operation and parameters shared by Call and Verify. */
function airnodeRequest(ctx: IExecuteFunctions, i: number): IDataObject {
	const listingUrl = String(ctx.getNodeParameter('listingUrl', i, '') ?? '').trim();
	if (!LISTING_URL.test(listingUrl)) {
		throw new NodeOperationError(ctx.getNode(), 'Listing URL must be an AirnodeHub listing root such as https://airnode-gleif.fly.dev/', { itemIndex: i });
	}
	const operation = String(ctx.getNodeParameter('airnodeOperation', i, '') ?? '').trim();
	if (!operation) throw new NodeOperationError(ctx.getNode(), 'Airnode Operation is required', { itemIndex: i });
	const parameters = parseJson(ctx, ctx.getNodeParameter('airnodeParameters', i, '{}'), 'Parameters (JSON)', i);
	if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
		throw new NodeOperationError(ctx.getNode(), 'Parameters (JSON) must be a JSON object', { itemIndex: i });
	}
	return { listingUrl, operation, parameters: parameters as IDataObject };
}

/** A JSON parameter arrives as a string, or as a value when it came from an expression. */
function parseJson(ctx: IExecuteFunctions, raw: unknown, label: string, itemIndex: number): unknown {
	if (typeof raw !== 'string') return raw;
	try {
		return JSON.parse(raw);
	} catch {
		throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`, { itemIndex });
	}
}
