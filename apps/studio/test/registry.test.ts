import { describe, expect, it } from 'vitest';
import { Registry, cardUrl, plainText, priceText } from '@/lib/registry';

const hit = (id: string, over: Record<string, unknown> = {}) => ({
  entity_id: `zns:${id.padEnd(32, '0')}`,
  name: `Agent ${id}`,
  summary: `Does ${id}. In: a name.`,
  category: 'compliance',
  status: 'active',
  entity_type: 'agent',
  url: `https://gw.example.com/a/zns:${id.padEnd(32, '0')}`,
  ...over,
});
const card = (price: unknown) => ({ 'x-zynd': { pricing: { rates: { default: price } } } });

function fakeFetch(opts: { results: unknown[]; cards: Record<string, unknown>; searchStatus?: number }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/search')) return opts.searchStatus && opts.searchStatus !== 200 ? new Response('no', { status: opts.searchStatus }) : Response.json({ results: opts.results });
    const body = opts.cards[url];
    return body === undefined ? new Response('nope', { status: 404 }) : Response.json(body);
  }) as typeof fetch;
  return { impl, calls };
}

const registry = (f: ReturnType<typeof fakeFetch>, maxCallPriceUsd = '0.25') => new Registry({ agentDnsUrl: 'https://dns.example.com', maxCallPriceUsd, fetchImpl: f.impl });
const cardOf = (h: ReturnType<typeof hit>) => `${h.url}/.well-known/agent-card.json`;

describe('Registry.search', () => {
  it('finds active agents and reads each price from its public card', async () => {
    const a = hit('aaaa');
    const b = hit('bbbb');
    const f = fakeFetch({ results: [a, b], cards: { [cardOf(a)]: card(0.05), [cardOf(b)]: card('0.1') } });
    const found = await registry(f).search('company check');
    expect(found.map((c) => [c.name, c.priceUsd])).toEqual([['Agent aaaa', '0.05'], ['Agent bbbb', '0.10']]);
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toMatchObject({ query: 'company check' });
  });

  it('leaves out agents that are not active, not agents, unpriced, unreachable or too dear', async () => {
    const ok = hit('okok');
    const inactive = hit('dead', { status: 'inactive' });
    const notAgent = hit('tool', { entity_type: 'service' });
    const noCard = hit('nocard');
    const noPrice = hit('noprice');
    const dear = hit('dear');
    const f = fakeFetch({ results: [ok, inactive, notAgent, noCard, noPrice, dear], cards: { [cardOf(ok)]: card(0.05), [cardOf(noPrice)]: {}, [cardOf(dear)]: card(2.5) } });
    expect((await registry(f).search('x')).map((c) => c.name)).toEqual(['Agent okok']);
  });

  it('remembers what it found, so a preview can only show real helpers and prices', async () => {
    const a = hit('aaaa');
    const r = registry(fakeFetch({ results: [a], cards: { [cardOf(a)]: card(0.05) } }));
    expect(r.lookup(a.entity_id)).toBeUndefined();
    await r.search('x');
    expect(r.lookup(a.entity_id)).toMatchObject({ name: 'Agent aaaa', priceUsd: '0.05' });
    expect(r.lookup('zns:invented')).toBeUndefined();
  });

  it('forgets after ten minutes', async () => {
    const a = hit('aaaa');
    let now = 0;
    const r = new Registry({ agentDnsUrl: 'https://dns.example.com', maxCallPriceUsd: '1', fetchImpl: fakeFetch({ results: [a], cards: { [cardOf(a)]: card(0.05) } }).impl, now: () => now });
    await r.search('x');
    now = 11 * 60_000;
    expect(r.lookup(a.entity_id)).toBeUndefined();
  });

  it('says plainly when the directory is down', async () => {
    await expect(registry(fakeFetch({ results: [], cards: {}, searchStatus: 503 })).search('x')).rejects.toThrow(/answered 503/);
    const dead = new Registry({ agentDnsUrl: 'https://dns.example.com', maxCallPriceUsd: '1', fetchImpl: (async () => Promise.reject(new Error('down'))) as typeof fetch });
    await expect(dead.search('x')).rejects.toThrow(/could not be reached/);
  });

  it('never fetches a card address that points inside the server', async () => {
    const evil = [hit('e1', { url: 'http://localhost:8090/a/x' }), hit('e2', { url: 'https://169.254.169.254/latest' }), hit('e3', { url: 'https://10.0.0.5/a/x' }), hit('e4', { url: 'file:///etc/passwd' }), hit('e5', { url: 'https://user:pw@example.com/a' }), hit('e6', { url: 'http://example.com/a' })];
    const f = fakeFetch({ results: evil, cards: {} });
    expect(await registry(f).search('x')).toEqual([]);
    expect(f.calls.map((c) => c.url)).toEqual(['https://dns.example.com/v1/search']);
  });

  it('fetches cards without following redirects', async () => {
    const a = hit('aaaa');
    const f = fakeFetch({ results: [a], cards: { [cardOf(a)]: card(0.05) } });
    await registry(f).search('x');
    expect(f.calls[1]?.init?.redirect).toBe('error');
  });
});

describe('cardUrl and priceText', () => {
  it('builds the card address, https only', () => {
    expect(cardUrl('https://gw.example.com/a/zns:abc')?.href).toBe('https://gw.example.com/a/zns:abc/.well-known/agent-card.json');
    expect(cardUrl('https://gw.example.com/a/zns:abc/')?.href).toBe('https://gw.example.com/a/zns:abc/.well-known/agent-card.json');
    expect(cardUrl('http://gw.example.com/a')).toBeNull();
    expect(cardUrl(42)).toBeNull();
    expect(cardUrl('not a url')).toBeNull();
  });
  it('writes prices the way a price reads', () => {
    expect(priceText(0.05)).toBe('0.05');
    expect(priceText(1)).toBe('1.00');
    expect(priceText(0.0125)).toBe('0.0125');
    expect(priceText(0.1)).toBe('0.10');
    expect(priceText(0)).toBe('0.00');
  });
});

describe('what a found agent says about itself', () => {
  it('is made plain: one line, no braces, no leading "=", cut to length', () => {
    expect(plainText('  Checks\n  a company. {{ $env.SECRET }}  ', 300)).toBe('Checks a company. $env.SECRET');
    expect(plainText('= {{ 1 + 1 }}', 50)).toBe('1 + 1');
    expect(plainText(undefined, 50)).toBe('');
    expect(plainText('x'.repeat(500), 80)).toHaveLength(80);
  });

  it('is what Studio keeps: a card that tries to write an expression in its summary gets none', async () => {
    const h = hit('a', { name: '={{ $env.KEY }}Sneaky', summary: '={{ $env.N8N_ENCRYPTION_KEY }} Looks up companies.' });
    const f = fakeFetch({ results: [h], cards: { [cardOf(h)]: card(0.05) } });
    const [found] = await registry(f).search('company');
    expect(found?.name).not.toMatch(/[{}=]/);
    expect(found?.what).toBe('$env.N8N_ENCRYPTION_KEY Looks up companies.');
  });
});
