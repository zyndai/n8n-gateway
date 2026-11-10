import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { disconnectDb } from './db/client.js';
import { Metrics } from './observability/metrics.js';
import { RateLimiter } from './services/RateLimiter.js';
import { getServices } from './services/container.js';

const config = loadConfig();
// M5.1: gauges read the services lazily, so a Gateway running without a database still serves /metrics.
const metrics = new Metrics();
const rateLimiter = new RateLimiter(config.rateLimit);
metrics.gauge({ name: 'gateway_heartbeats_active', help: 'Listings with a live AgentDNS heartbeat socket.', value: () => (config.databaseUrl ? getServices().heartbeats.size : undefined) });
metrics.gauge({ name: 'gateway_cluster_live_instances', help: 'Gateway instances this one sees alive, itself included.', value: () => (config.databaseUrl ? getServices().cluster.live().length : undefined) });
metrics.gauge({ name: 'gateway_rate_limit_keys', help: 'API keys with a non-full rate limit bucket.', value: () => rateLimiter.size });
metrics.counter('gateway_rate_limited_total', 'Requests rejected with RATE_LIMITED since boot.', () => rateLimiter.rejected);
// Idle buckets behave like unseen keys, so dropping them is free; this keeps the map small.
setInterval(() => rateLimiter.prune(), 60_000).unref();
const server = createApp({ config, metrics, rateLimiter }).listen(config.port, () => {
  console.log(`zynd-n8n-gateway listening on :${config.port} (${config.nodeEnv})`);
});

// M1.11: resume heartbeats for every ACTIVE listing. Skipped (with a warning) when the Gateway
// runs without a database, e.g. a bare `npm run dev` for /health.
if (config.databaseUrl) {
  let services: ReturnType<typeof getServices>;
  try {
    services = getServices(); // validates PKI_ENCRYPTION_KEY etc. up front: fail fast, not on first request
  } catch (err) {
    console.error(`startup failed: ${(err as Error).message}`);
    process.exit(1);
  }
  // G5: expired x-zynd-auth nonces are dead weight; purge them every minute.
  setInterval(() => void services.nonces.purgeExpired().catch((err: unknown) => console.error('nonce purge failed', err)), 60_000).unref();
  // M2.20: settle or release payments a crash left behind, once now and then every minute.
  const sweep = (): void => void services.recovery.run().catch((err: unknown) => console.error('payment recovery failed', err));
  sweep();
  setInterval(sweep, 60_000).unref();
  // M1.11 / M5.3: resume this instance's heartbeats, then keep them in line with the database and
  // the live peers. With no peers this instance owns everything.
  services.cluster.start();
  void services.cluster.check().finally(() => services.coordinator.begin(config.cluster.reconcileIntervalMs));
} else {
  console.warn('DATABASE_URL not set: heartbeat recovery and listing routes are disabled');
}

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  // Sockets close without touching the DB, so listings resume on the next boot.
  if (config.databaseUrl) {
    const s = getServices();
    s.coordinator.end();
    s.cluster.stop();
    s.heartbeats.shutdown();
  }
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
