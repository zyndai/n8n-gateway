import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { CREDENTIAL, gatewayRequest } from './gateway';

type Operation = 'searchAgents' | 'callAgent' | 'getTask' | 'completeJob' | 'listListings';

/** The Gateway caps a task at 300 s; wait a little longer so its own timeout error arrives first. */
const CALL_TIMEOUT_MS = 310_000;

/** A decimal USD amount with at most 6 decimals, the Gateway's limit. */
const USD = /^\d+(\.\d{1,6})?$/;

interface TaskResult {
	taskId: string;
	status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELED';
	output: unknown;
	error: string | null;
}

export class Zynd implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Zynd',
		name: 'zynd',
		icon: { light: 'file:zynd.svg', dark: 'file:zynd.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Find agents on the Zynd network, call them with x402 payments, and finish jobs for your own listings',
		defaults: { name: 'Zynd' },
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
				default: 'searchAgents',
				options: [
					{
						name: 'Call Agent',
						value: 'callAgent',
						action: 'Call an agent',
						description: 'Send a task to an agent and wait for its answer. Paid agents are paid with x402 from your Zynd account.',
					},
					{
						name: 'Complete Job',
						value: 'completeJob',
						action: 'Complete a job',
						description: 'Report the result of a job that arrived through the Zynd Trigger',
					},
					{
						name: 'Get Task',
						value: 'getTask',
						action: 'Get a task',
						description: 'Read the status and result of a task started by Call Agent',
					},
					{
						name: 'List Listings',
						value: 'listListings',
						action: 'List your listings',
						description: 'List the agents you have published through the Gateway',
					},
					{
						name: 'Search Agents',
						value: 'searchAgents',
						action: 'Search for agents',
						description: 'Search the Zynd network for agents',
					},
				],
			},

			// Search agents
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				default: '',
				description: 'What the agent should do, in your own words',
				displayOptions: { show: { operation: ['searchAgents'] } },
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'string',
				default: '',
				description: 'Only return agents in this category. Leave empty for all.',
				displayOptions: { show: { operation: ['searchAgents'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { operation: ['searchAgents'] } },
			},
			{
				displayName: 'Offset',
				name: 'offset',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 0,
				description: 'Number of results to skip, for paging',
				displayOptions: { show: { operation: ['searchAgents'] } },
			},

			// Call agent
			{
				displayName: 'Agent ID',
				name: 'agentId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'zns:…',
				description: 'The agent\'s entity ID, as returned by Search Agents',
				displayOptions: { show: { operation: ['callAgent'] } },
			},
			{
				displayName: 'Input Type',
				name: 'inputType',
				type: 'options',
				default: 'text',
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'JSON', value: 'json' },
				],
				description: 'How the task input is sent to the agent',
				displayOptions: { show: { operation: ['callAgent'] } },
			},
			{
				displayName: 'Input',
				name: 'inputText',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'The task, sent as a text message',
				displayOptions: { show: { operation: ['callAgent'], inputType: ['text'] } },
			},
			{
				displayName: 'Input (JSON)',
				name: 'inputJson',
				type: 'json',
				default: '{}',
				description: 'The task, sent as structured data',
				displayOptions: { show: { operation: ['callAgent'], inputType: ['json'] } },
			},
			{
				displayName: 'Max Payment (USD)',
				name: 'maxPaymentUsd',
				type: 'string',
				default: '',
				placeholder: '0.05',
				description:
					'The most you are willing to pay for this call, in USD (up to 6 decimals). The call fails if the agent asks for more. Leave empty to use the Gateway default.',
				displayOptions: { show: { operation: ['callAgent'] } },
			},

			// Get task
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				default: '',
				required: true,
				description: 'The task ID returned by Call Agent',
				displayOptions: { show: { operation: ['getTask'] } },
			},

			// Complete job
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				default: '={{ $json.jobId }}',
				required: true,
				description: 'The job to finish. The Zynd Trigger puts it in the field jobId.',
				displayOptions: { show: { operation: ['completeJob'] } },
			},
			{
				displayName: 'Outcome',
				name: 'outcome',
				type: 'options',
				default: 'success',
				options: [
					{ name: 'Success', value: 'success' },
					{ name: 'Failure', value: 'failure' },
				],
				description: 'Whether the workflow produced a result or failed',
				displayOptions: { show: { operation: ['completeJob'] } },
			},
			{
				displayName: 'Output (JSON)',
				name: 'output',
				type: 'json',
				default: '{}',
				description: 'The result to send back to the caller. Any JSON value.',
				displayOptions: { show: { operation: ['completeJob'], outcome: ['success'] } },
			},
			{
				displayName: 'Error Message',
				name: 'errorMessage',
				type: 'string',
				default: 'The workflow failed',
				description: 'What the caller is told. The caller is not charged for a failed job.',
				displayOptions: { show: { operation: ['completeJob'], outcome: ['failure'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			let failure: unknown;
			try {
				const operation = this.getNodeParameter('operation', i, 'searchAgents') as Operation;
				for (const json of await run(this, operation, i)) out.push({ json, pairedItem: { item: i } });
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

async function run(ctx: IExecuteFunctions, operation: Operation, i: number): Promise<IDataObject[]> {
	switch (operation) {
		case 'searchAgents': {
			const qs: IDataObject = {
				limit: ctx.getNodeParameter('limit', i, 50) as number,
				offset: ctx.getNodeParameter('offset', i, 0) as number,
			};
			const query = (ctx.getNodeParameter('query', i, '') as string).trim();
			const category = (ctx.getNodeParameter('category', i, '') as string).trim();
			if (query) qs.q = query;
			if (category) qs.category = category;
			const { body } = await gatewayRequest<{ results?: IDataObject[] }>(ctx, { method: 'GET', path: '/agents', qs, itemIndex: i });
			return body?.results ?? [];
		}

		case 'callAgent': {
			const agentId = (ctx.getNodeParameter('agentId', i, '') as string).trim();
			if (!agentId) throw new NodeOperationError(ctx.getNode(), 'Agent ID is required', { itemIndex: i });
			const body: IDataObject = { input: callInput(ctx, i) as IDataObject };
			const max = String(ctx.getNodeParameter('maxPaymentUsd', i, '') ?? '').trim();
			if (max) {
				if (!USD.test(max)) {
					throw new NodeOperationError(ctx.getNode(), 'Max Payment must be an amount in USD such as 0.05 (up to 6 decimals)', { itemIndex: i });
				}
				body.maxPaymentUsd = max;
			}
			const res = await gatewayRequest<TaskResult>(ctx, {
				method: 'POST',
				path: `/agents/${encodeURIComponent(agentId)}/tasks`,
				body,
				timeoutMs: CALL_TIMEOUT_MS,
				notFound: 'Agent',
				itemIndex: i,
			});
			return [failIfNotCompleted(ctx, res.body, i)];
		}

		case 'getTask': {
			const taskId = (ctx.getNodeParameter('taskId', i, '') as string).trim();
			if (!taskId) throw new NodeOperationError(ctx.getNode(), 'Task ID is required', { itemIndex: i });
			const res = await gatewayRequest<IDataObject>(ctx, { method: 'GET', path: `/tasks/${encodeURIComponent(taskId)}`, notFound: 'Task', itemIndex: i });
			return [res.body];
		}

		case 'completeJob': {
			const jobId = (ctx.getNodeParameter('jobId', i, '') as string).trim();
			if (!jobId) throw new NodeOperationError(ctx.getNode(), 'Job ID is required', { itemIndex: i });
			const failed = ctx.getNodeParameter('outcome', i, 'success') === 'failure';
			let body: IDataObject;
			if (failed) {
				const message = String(ctx.getNodeParameter('errorMessage', i, '') ?? '').trim();
				body = { error: message || 'The workflow failed' };
			} else {
				body = { output: parseJson(ctx, ctx.getNodeParameter('output', i, '{}'), 'Output', i) as IDataObject };
			}
			const res = await gatewayRequest<IDataObject>(ctx, {
				method: 'POST',
				path: `/jobs/${encodeURIComponent(jobId)}/complete`,
				body,
				notFound: 'Job',
				itemIndex: i,
			});
			return [res.body];
		}

		case 'listListings': {
			const { body } = await gatewayRequest<{ listings?: IDataObject[] }>(ctx, { method: 'GET', path: '/listings', itemIndex: i });
			return body?.listings ?? [];
		}

		default:
			throw new NodeOperationError(ctx.getNode(), `Unknown operation: ${String(operation)}`, { itemIndex: i });
	}
}

function callInput(ctx: IExecuteFunctions, i: number): unknown {
	if (ctx.getNodeParameter('inputType', i, 'text') === 'json') {
		return parseJson(ctx, ctx.getNodeParameter('inputJson', i, '{}'), 'Input (JSON)', i);
	}
	return ctx.getNodeParameter('inputText', i, '');
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

/** The Gateway answers 200 for a task that ended badly; surface that as an error instead of an empty result. */
function failIfNotCompleted(ctx: IExecuteFunctions, task: TaskResult, itemIndex: number): IDataObject {
	if (task.status === 'FAILED' || task.status === 'TIMEOUT' || task.status === 'CANCELED') {
		throw new NodeOperationError(ctx.getNode(), `Agent task ${task.status.toLowerCase()}`, {
			itemIndex,
			description: [task.error, `Task ID: ${task.taskId}`].filter(Boolean).join('. '),
		});
	}
	return task as unknown as IDataObject;
}
