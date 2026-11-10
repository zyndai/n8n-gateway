// M5.2 (G11): per-API-key rate limit on /n8n/v1/*. A token bucket per key: `burst` tokens, refilled
// at `perMinute / 60` per second, one token per request. In-process, so with several Gateway
// instances (M5.3) each one enforces its own bucket; with consistent routing per key that is the
// same limit, otherwise the effective limit is at most instances x perMinute.
export interface RateLimiterOptions {
  /** Sustained requests per minute per key. 0 disables the limiter. */
  perMinute: number;
  /** Bucket size: how many requests a key may send at once after being idle. */
  burst: number;
  now?: () => number;
  /** Upper bound on tracked keys; idle (full) buckets are dropped first when it is reached. */
  maxKeys?: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until one more request would be allowed (0 when allowed). */
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly ratePerMs: number;
  private readonly maxKeys: number;
  /** Requests turned away since boot, for /metrics. */
  rejected = 0;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.ratePerMs = opts.perMinute / 60_000;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  get enabled(): boolean {
    return this.opts.perMinute > 0 && this.opts.burst > 0;
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string): RateDecision {
    const limit = this.opts.burst;
    if (!this.enabled) return { allowed: true, limit, remaining: limit, retryAfterSec: 0 };
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(t);
      b = { tokens: limit, at: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(limit, b.tokens + (t - b.at) * this.ratePerMs);
      b.at = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, limit, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }
    this.rejected++;
    return { allowed: false, limit, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / this.ratePerMs / 1000)) };
  }

  /** Drop buckets that have refilled completely: they behave exactly like a key never seen. */
  prune(t: number = this.now()): number {
    let n = 0;
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * this.ratePerMs >= this.opts.burst) {
        this.buckets.delete(k);
        n++;
      }
    }
    // Still full of busy keys: forget the oldest rather than grow without bound.
    if (this.buckets.size >= this.maxKeys) {
      for (const k of this.buckets.keys()) {
        this.buckets.delete(k);
        n++;
        if (this.buckets.size < this.maxKeys) break;
      }
    }
    return n;
  }
}
