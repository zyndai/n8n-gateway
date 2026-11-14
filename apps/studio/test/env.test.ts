import { describe, expect, it } from 'vitest';
import { ConfigError, builderConfigured, builderEnv, creditEnv, parseDataSources } from '@/lib/env';

describe('parseDataSources', () => {
  const good = { name: 'Briefpixel news', listingUrl: 'https://airnode-briefpixel.fly.dev', operation: 'listArticles', what: 'News', maxPriceUsd: '0.01', fields: 'q, limit' };
  it('reads a list and normalises the address to its root', () => {
    expect(parseDataSources(JSON.stringify([good]))).toEqual([{ ...good, listingUrl: 'https://airnode-briefpixel.fly.dev/' }]);
  });
  it('defaults the price and leaves out what is not well formed, never guessing', () => {
    const list = parseDataSources(JSON.stringify([{ ...good, maxPriceUsd: undefined }, { ...good, name: '' }, { ...good, listingUrl: 'http://insecure.example.com' }, { ...good, listingUrl: 'nope' }, { ...good, maxPriceUsd: 'free' }, { ...good, operation: '' }, 'junk', null]));
    expect(list.map((s) => s.maxPriceUsd)).toEqual(['0.05']);
  });
  it('is empty for nothing or junk', () => {
    for (const raw of [undefined, '', '  ', 'not json', '{"a":1}', '42']) expect(parseDataSources(raw)).toEqual([]);
  });
});

describe('builderEnv', () => {
  const env = { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-5', N8N_OPENAI_CREDENTIAL_ID: 'cred1' };
  it('reads the settings with defaults', () => {
    expect(builderEnv(env)).toMatchObject({ openAiApiKey: 'sk-test', openAiModel: 'gpt-5', agentModel: 'gpt-5-mini', openAiCredentialId: 'cred1', agentDnsUrl: 'https://zns01.zynd.ai', maxCallPriceUsd: '0.25', dataSources: [] });
  });
  it('names what is missing without printing a value', () => {
    try {
      builderEnv({ OPENAI_API_KEY: 'sk-secret-value' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).missing).toEqual(['OPENAI_MODEL', 'N8N_OPENAI_CREDENTIAL_ID']);
      expect((e as Error).message).not.toContain('sk-secret-value');
    }
  });
  it('is "configured" only with every setting for sign-in and the builder', () => {
    expect(builderConfigured({})).toBe(false);
    expect(builderConfigured(env)).toBe(false); // the sign-in settings are missing too
  });
});

describe('creditEnv', () => {
  it('is off without a platform wallet', () => expect(creditEnv({})).toBeNull());
  it('reads the wallet with the test-network defaults', () => {
    expect(creditEnv({ TREASURY_PRIVATE_KEY: '0xabc' })).toMatchObject({ treasuryKey: '0xabc', rpcUrl: 'https://sepolia.base.org', chainId: 84532, decimals: 6, amountUsd: '1', maxAgents: 3, asset: '0xbeA34973e5f67F18F656A2C6070C64326C791808' });
    expect(creditEnv({ TREASURY_PRIVATE_KEY: '0xabc', STARTER_CREDIT_USD: '2', STARTER_CREDIT_MAX_AGENTS: '1', X402_RPC_URL: 'https://rpc.example.com/' })).toMatchObject({ amountUsd: '2', maxAgents: 1, rpcUrl: 'https://rpc.example.com' });
  });
});
