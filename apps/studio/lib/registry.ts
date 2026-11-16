// Finding helpers (S2.4 `find_helpers`): the registry's search answers without a key (S0.5 d), and each result's
// public agent card holds the price. The card address comes from registry data, so it is fetched defensively:
// https only, public hosts only, no redirects, small and quick.
import { isInternalHost } from './n8n/policy';

export interface HelperCard {
  entityId: string;
  name: string;
  /** The listing summary: what it does and, for the showcase agents, what it takes in. */
  what: string;
  category: string;
  /** Price per use, a decimal string. */
  priceUsd: string;
}

export interface RegistryConfig {
  agentDnsUrl: string;
  /** Helpers dearer than this are not offered. */
  maxCallPriceUsd: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface SearchHit {
  entity_id?: unknown;
  name?: unknown;
  summary?: unknown;
  category?: unknown;
  status?: unknown;
  entity_type?: unknown;
  url?: unknown;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const CARD_MAX_BYTES = 200_000;

/**
 * Text from another agent's public card ends up in tool descriptions and prompts. Collapse it to one plain line, and
 * make sure n8n can never read it as an expression (a leading `=` or `{{ … }}`).
 */
export const plainText = (v: unknown, max: number): string =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^=+\s*/, '')
    .slice(0, max);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 0.05 -> "0.05", 1 -> "1.00", 0.0125 -> "0.0125": no more zeros than a price needs, never fewer than two decimals. */
export function priceText(n: number): string {
  const [whole = '0', frac = ''] = n.toFixed(6).split('.');
  return `${whole}.${frac.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** `https://host/a/zns:…` -> the agent card address, or null for an address Studio will not fetch. */
export function cardUrl(entityUrl: unknown): URL | null {
  if (typeof entityUrl !== 'string') return null;
  try {
    const u = new URL(entityUrl);
    if (u.protocol !== 'https:' || u.username || u.password || isInternalHost(u.hostname)) return null;
    return new URL('.well-known/agent-card.json', u.href.endsWith('/') ? u.href : `${u.href}/`);
  } catch {
    return null;
  }
}

export class Registry {
  private readonly cache = new Map<string, { at: number; card: HelperCard }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: RegistryConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  /** A helper found earlier in this process, or undefined. `update_preview` uses it so prices are never invented. */
  lookup(entityId: string): HelperCard | undefined {
    const hit = this.cache.get(entityId);
    return hit && this.now() - hit.at < CACHE_TTL_MS ? hit.card : undefined;
  }

  private remember(card: HelperCard): void {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(card.entityId, { at: this.now(), card });
  }

  /** Active agents matching the words, with their prices. Agents whose price cannot be read, or is too high, are left out. */
  async search(query: string, limit = 6): Promise<HelperCard[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.agentDnsUrl}/v1/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.slice(0, 200), max_results: 12, offset: 0 }),
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('The agent directory could not be reached');
    }
    if (!res.ok) throw new Error(`The agent directory answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { results?: SearchHit[] } | null;
    const hits = (body?.results ?? []).filter(
      (h) => typeof h.entity_id === 'string' && typeof h.name === 'string' && h.status === 'active' && (h.entity_type === undefined || h.entity_type === 'agent'),
    );
    const cards = await Promise.all(hits.slice(0, 10).map((h) => this.card(h)));
    const max = Number(this.cfg.maxCallPriceUsd);
    return cards.filter((c): c is HelperCard => c !== null && Number(c.priceUsd) <= max).slice(0, limit);
  }

  private async card(h: SearchHit): Promise<HelperCard | null> {
    const url = cardUrl(h.url);
    if (!url) return null;
    try {
      const res = await this.fetchImpl(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000), headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > CARD_MAX_BYTES) return null;
      const card = JSON.parse(text) as unknown;
      const rate = isObj(card) && isObj(card['x-zynd']) && isObj(card['x-zynd'].pricing) && isObj(card['x-zynd'].pricing.rates) ? card['x-zynd'].pricing.rates.default : undefined;
      const price = typeof rate === 'number' ? rate : typeof rate === 'string' ? Number(rate) : NaN;
      if (!Number.isFinite(price) || price < 0) return null;
      const out: HelperCard = {
        entityId: h.entity_id as string,
        name: plainText(h.name, 80),
        what: plainText(h.summary, 300),
        category: plainText(h.category, 40),
        priceUsd: priceText(price),
      };
      this.remember(out);
      return out;
    } catch {
      return null;
    }
  }
}
