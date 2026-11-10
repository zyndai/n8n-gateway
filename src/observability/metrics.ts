// M5.1: Prometheus text metrics with no dependency. Labels are a fixed small set (route group and
// status class) so memory stays flat however many listings, keys or tasks exist.
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export type RouteGroup = 'n8n' | 'a2a' | 'card' | 'internal' | 'health' | 'metrics' | 'other';

/** Upper bounds in seconds. A2A calls wait on n8n for up to 300 s, so the tail goes that far. */
export const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

export function routeGroup(url: string): RouteGroup {
  if (url.startsWith('/n8n/v1')) return 'n8n';
  if (url.startsWith('/a/')) return url.includes('/.well-known/') ? 'card' : 'a2a';
  if (url.startsWith('/internal/v1')) return 'internal';
  if (url.startsWith('/health')) return 'health';
  if (url.startsWith('/metrics')) return 'metrics';
  return 'other';
}

interface Hist {
  counts: number[]; // one per bucket, cumulative is computed on render
  sum: number;
  count: number;
}

export interface GaugeSource {
  name: string;
  help: string;
  /** undefined = not available right now (e.g. no database), the gauge is left out. */
  value: () => number | undefined;
}

export class Metrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<RouteGroup, Hist>();
  private readonly counters = new Map<string, { help: string; value: () => number | undefined }>();
  private readonly gauges: GaugeSource[] = [];
  private readonly startedAt = Date.now();

  /** Count one finished request. `seconds` is wall time from arrival to the end of the response. */
  observe(group: RouteGroup, status: number, seconds: number): void {
    const key = `${group}|${Math.floor(status / 100)}xx`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    let h = this.durations.get(group);
    if (!h) {
      h = { counts: new Array<number>(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.durations.set(group, h);
    }
    const i = DURATION_BUCKETS.findIndex((b) => seconds <= b);
    if (i >= 0) h.counts[i] = (h.counts[i] as number) + 1;
    h.sum += seconds;
    h.count++;
  }

  gauge(g: GaugeSource): void {
    this.gauges.push(g);
  }

  counter(name: string, help: string, value: () => number | undefined): void {
    this.counters.set(name, { help, value });
  }

  /** Express middleware that records every request. */
  middleware(): RequestHandler {
    return (req, res, next) => {
      const started = process.hrtime.bigint();
      res.on('finish', () => this.observe(routeGroup(req.originalUrl), res.statusCode, Number(process.hrtime.bigint() - started) / 1e9));
      next();
    };
  }

  render(): string {
    const out: string[] = [];
    const mem = process.memoryUsage();
    const gauge = (name: string, help: string, v: number | undefined): void => {
      if (v === undefined || !Number.isFinite(v)) return;
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${v}`);
    };
    gauge('gateway_uptime_seconds', 'Seconds since the process started.', (Date.now() - this.startedAt) / 1000);
    gauge('process_resident_memory_bytes', 'Resident set size, to compare with the memory budget.', mem.rss);
    gauge('process_heap_used_bytes', 'V8 heap in use.', mem.heapUsed);
    for (const g of this.gauges) gauge(g.name, g.help, g.value());

    for (const [name, c] of this.counters) {
      const v = c.value();
      if (v === undefined) continue;
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`, `${name} ${v}`);
    }

    out.push('# HELP gateway_http_requests_total Requests by route group and status class.', '# TYPE gateway_http_requests_total counter');
    for (const [key, n] of [...this.requests].sort()) {
      const [group, cls] = key.split('|');
      out.push(`gateway_http_requests_total{group="${group}",status="${cls}"} ${n}`);
    }

    out.push('# HELP gateway_http_request_duration_seconds Request duration by route group.', '# TYPE gateway_http_request_duration_seconds histogram');
    for (const [group, h] of [...this.durations].sort()) {
      let cum = 0;
      DURATION_BUCKETS.forEach((b, i) => {
        cum += h.counts[i] as number;
        out.push(`gateway_http_request_duration_seconds_bucket{group="${group}",le="${b}"} ${cum}`);
      });
      out.push(`gateway_http_request_duration_seconds_bucket{group="${group}",le="+Inf"} ${h.count}`);
      out.push(`gateway_http_request_duration_seconds_sum{group="${group}"} ${h.sum}`, `gateway_http_request_duration_seconds_count{group="${group}"} ${h.count}`);
    }
    return out.join('\n') + '\n';
  }
}

/** `GET /metrics` handler guarded by a bearer token (constant-time compare). */
export function metricsHandler(metrics: Metrics, token: string): RequestHandler {
  const want = Buffer.from(token, 'utf8');
  return (req, res) => {
    const header = req.header('authorization') ?? '';
    const got = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '', 'utf8');
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'Invalid metrics token', code: 'AUTH_INVALID' });
      return;
    }
    res.type('text/plain; version=0.0.4').send(metrics.render());
  };
}
