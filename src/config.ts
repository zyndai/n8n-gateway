export interface Config {
  port: number;
  nodeEnv: string;
  databaseUrl: string | undefined;
  agentDnsUrl: string;
  publicUrl: string;
  /** Hex (64 chars) AES-256-GCM key, the same `PKI_ENCRYPTION_KEY` the dashboard uses. */
  pkiEncryptionKey: string | undefined;
  /** HS256 secret shared with the dashboard for Session JWTs (M1.8). */
  sessionJwtSecret: string | undefined;
  /**
   * G7: when true (default) a listing only heartbeats once it has a webhook bound, so an agent
   * is never advertised as live while it cannot receive jobs. Set false to heartbeat as soon
   * as the listing is registered.
   */
  heartbeatRequiresWebhook: boolean;
  /** Accept webhook URLs on loopback / private networks. Default: only outside production. */
  allowPrivateWebhooks: boolean;
  /** M5.2: per-API-key request limit on /n8n/v1/*. */
  rateLimit: { perMinute: number; burst: number };
  /** M5.1: bearer token for `GET /metrics`. Unset = the endpoint does not exist. */
  metricsToken: string | undefined;
  /** M5.3: this instance's place in a multi-instance deployment. */
  cluster: ClusterConfig;
  x402: X402Config;
}

export interface ClusterConfig {
  /** Stable name of this instance, the same one its peers list for it. */
  instanceId: string;
  /** `id=url` of every other instance. Empty = a single instance that owns every heartbeat. */
  peers: string | undefined;
  probeIntervalMs: number;
  /** Consecutive failed health probes before a peer's listings move. */
  failThreshold: number;
  /** How often the instance re-reads the active listings and fixes its heartbeats. */
  reconcileIntervalMs: number;
}

/** x402 settings (M2.7, M2.13). Defaults target Base Sepolia USDC so nothing real is spent by accident. */
export interface X402Config {
  /** Facilitator that verifies and settles payments (`POST {url}/verify`, `POST {url}/settle`). */
  facilitatorUrl: string;
  /** CAIP-2 network, e.g. `eip155:84532`. */
  network: string;
  /** ERC-20 (EIP-3009) token contract used for payment, USDC by default. */
  asset: string;
  /** EIP-712 domain `name` and `version` of that token. */
  assetName: string;
  assetVersion: string;
  assetDecimals: number;
  /**
   * Price of one inbound call in USD. Set: every inbound call must carry a valid payment.
   * Unset (default): payment is optional and is verified only when a proof is present (LLD step 3).
   */
  inboundPriceUsd: string | undefined;
  /** Ceiling for one outbound payment when the caller passes no `maxPaymentUsd`. */
  defaultMaxPaymentUsd: string;
}

function nonNegInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  return {
    port,
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: env.DATABASE_URL,
    agentDnsUrl: (env.AGENTDNS_URL ?? 'https://dns01.zynd.ai').replace(/\/+$/, ''),
    publicUrl: (env.PUBLIC_URL ?? 'https://gw.zynd.ai').replace(/\/+$/, ''),
    pkiEncryptionKey: env.PKI_ENCRYPTION_KEY,
    sessionJwtSecret: env.SESSION_JWT_SECRET,
    heartbeatRequiresWebhook: bool(env.HEARTBEAT_REQUIRES_WEBHOOK, true),
    allowPrivateWebhooks: bool(env.WEBHOOK_ALLOW_PRIVATE, (env.NODE_ENV ?? 'development') !== 'production'),
    rateLimit: {
      perMinute: nonNegInt('RATE_LIMIT_PER_MINUTE', env.RATE_LIMIT_PER_MINUTE, 300),
      burst: nonNegInt('RATE_LIMIT_BURST', env.RATE_LIMIT_BURST, 60),
    },
    metricsToken: env.METRICS_TOKEN || undefined,
    cluster: {
      instanceId: env.INSTANCE_ID || 'gw-0',
      peers: env.CLUSTER_PEERS || undefined,
      probeIntervalMs: nonNegInt('CLUSTER_PROBE_INTERVAL_MS', env.CLUSTER_PROBE_INTERVAL_MS, 5_000) || 5_000,
      failThreshold: nonNegInt('CLUSTER_FAIL_THRESHOLD', env.CLUSTER_FAIL_THRESHOLD, 2) || 2,
      reconcileIntervalMs: nonNegInt('HEARTBEAT_RECONCILE_MS', env.HEARTBEAT_RECONCILE_MS, 15_000) || 15_000,
    },
    x402: {
      facilitatorUrl: (env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator').replace(/\/+$/, ''),
      network: env.X402_NETWORK ?? 'eip155:84532',
      asset: env.X402_ASSET ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      assetName: env.X402_ASSET_NAME ?? 'USDC',
      assetVersion: env.X402_ASSET_VERSION ?? '2',
      assetDecimals: Number(env.X402_ASSET_DECIMALS ?? 6),
      inboundPriceUsd: env.X402_INBOUND_PRICE_USD || undefined,
      defaultMaxPaymentUsd: env.X402_DEFAULT_MAX_PAYMENT_USD ?? '0.10',
    },
  };
}
