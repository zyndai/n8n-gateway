// M5.1: Prometheus text at /metrics, behind a bearer token.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DURATION_BUCKETS, Metrics, routeGroup } from '../src/observability/metrics.js';

describe('routeGroup', () => {
  it('maps paths to a small fixed set of labels', () => {
    expect(routeGroup('/n8n/v1/agents?q=x')).toBe('n8n');
    expect(routeGroup('/a/zns:abc/a2a/v1')).toBe('a2a');
    expect(routeGroup('/a/zns:abc/.well-known/agent-card.json')).toBe('card');
    expect(routeGroup('/internal/v1/listings')).toBe('internal');
    expect(routeGroup('/health')).toBe('health');
    expect(routeGroup('/random')).toBe('other');
  });
});

describe('Metrics', () => {
  it('renders request counts and a cumulative duration histogram', () => {
    const m = new Metrics();
    m.observe('n8n', 200, 0.02);
    m.observe('n8n', 200, 0.3);
    m.observe('n8n', 429, 0.001);
    m.observe('a2a', 504, 400);
    const text = m.render();
    expect(text).toContain('gateway_http_requests_total{group="n8n",status="2xx"} 2');
    expect(text).toContain('gateway_http_requests_total{group="n8n",status="4xx"} 1');
    expect(text).toContain('gateway_http_requests_total{group="a2a",status="5xx"} 1');
    expect(text).toContain('gateway_http_request_duration_seconds_bucket{group="n8n",le="0.01"} 1');
    expect(text).toContain('gateway_http_request_duration_seconds_bucket{group="n8n",le="0.05"} 2');
    expect(text).toContain('gateway_http_request_duration_seconds_bucket{group="n8n",le="+Inf"} 3');
    expect(text).toContain(`gateway_http_request_duration_seconds_bucket{group="a2a",le="${DURATION_BUCKETS.at(-1)}"} 0`); // slower than every bucket
    expect(text).toContain('gateway_http_request_duration_seconds_count{group="a2a"} 1');
    expect(text).toMatch(/process_resident_memory_bytes \d+/);
    expect(text).toMatch(/gateway_uptime_seconds [\d.]+/);
  });

  it('includes registered gauges and counters, and leaves out those that are unavailable', () => {
    const m = new Metrics();
    m.gauge({ name: 'gateway_heartbeats_active', help: 'h', value: () => 7 });
    m.gauge({ name: 'gateway_missing', help: 'h', value: () => undefined });
    m.counter('gateway_rate_limited_total', 'h', () => 3);
    const text = m.render();
    expect(text).toContain('gateway_heartbeats_active 7');
    expect(text).toContain('gateway_rate_limited_total 3');
    expect(text).not.toContain('gateway_missing');
  });
});

describe('GET /metrics', () => {
  const config = { sessionJwtSecret: 'x'.repeat(40) };

  it('does not exist without METRICS_TOKEN', async () => {
    expect((await request(createApp({ config })).get('/metrics')).status).toBe(404);
  });

  it('requires the bearer token and records the requests it sees', async () => {
    const app = createApp({ config: { ...config, metricsToken: 'scrape-secret-1' } });
    await request(app).get('/health');
    await request(app).get('/nope');
    expect((await request(app).get('/metrics')).status).toBe(401);
    expect((await request(app).get('/metrics').set('Authorization', 'Bearer wrong-secret-12')).status).toBe(401);

    const res = await request(app).get('/metrics').set('Authorization', 'Bearer scrape-secret-1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('gateway_http_requests_total{group="health",status="2xx"} 1');
    expect(res.text).toContain('gateway_http_requests_total{group="other",status="4xx"} 1');
    expect(res.text).toContain('gateway_http_requests_total{group="metrics",status="4xx"} 2');
  });
});
