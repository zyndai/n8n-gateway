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
  };
}
