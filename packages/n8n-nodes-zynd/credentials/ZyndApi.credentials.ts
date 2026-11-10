import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class ZyndApi implements ICredentialType {
	name = 'zyndApi';

	displayName = 'Zynd API';

	icon = { light: 'file:../nodes/Zynd/zynd.svg', dark: 'file:../nodes/Zynd/zynd.dark.svg' } as const;

	documentationUrl = 'https://github.com/zyndai/zynd-n8n-gateway/tree/main/packages/n8n-nodes-zynd#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API URL',
			name: 'apiUrl',
			type: 'string',
			default: 'https://gw.zynd.ai',
			required: true,
			description: 'Base URL of the Zynd Gateway. Change it only for a self-hosted or staging Gateway.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Create the key in the Zynd dashboard, under n8n. Its permissions decide which operations work.',
		},
		{
			displayName: 'Webhook Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Shared secret (8 to 256 characters) the Gateway sends with every job. Only the Zynd Trigger needs it. Re-activate the workflow after changing it.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-Zynd-Api-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	// Lists the key's listings, so the key needs the "complete" permission to pass this test.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.apiUrl}}',
			url: '/n8n/v1/listings',
		},
	};
}
