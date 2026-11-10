import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { disconnectDb } from './db/client.js';
import { getServices } from './services/container.js';

const config = loadConfig();
const server = createApp().listen(config.port, () => {
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
  services.heartbeats.resumeActive().catch((err: unknown) => console.error('heartbeat recovery failed', err));
} else {
  console.warn('DATABASE_URL not set: heartbeat recovery and listing routes are disabled');
}

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  // Sockets close without touching the DB, so listings resume on the next boot.
  if (config.databaseUrl) getServices().heartbeats.shutdown();
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
