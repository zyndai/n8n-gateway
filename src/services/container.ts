// Lazy composition root. Nothing here runs at import time, so tests and /health never need a
// database, secrets or an AgentDNS connection.
import { loadConfig, type Config } from '../config.js';
import { getDb } from '../db/client.js';
import { AgentDnsClient } from './AgentDnsClient.js';
import { HeartbeatManager } from './HeartbeatManager.js';
import { IdentityService } from './IdentityService.js';
import { ListingService } from './ListingService.js';
import { ListingStore } from './ListingStore.js';
import { parseMasterKey } from './keyVault.js';

export interface Services {
  config: Config;
  store: ListingStore;
  identity: IdentityService;
  heartbeats: HeartbeatManager;
  listings: ListingService;
}

let services: Services | undefined;

export function getServices(): Services {
  if (services) return services;
  const config = loadConfig();
  const store = new ListingStore(getDb());
  const identity = new IdentityService({ masterKey: parseMasterKey(config.pkiEncryptionKey), keySource: store });
  const agentDns = new AgentDnsClient(config.agentDnsUrl);
  const heartbeats = new HeartbeatManager({
    heartbeatUrl: (id) => agentDns.heartbeatUrl(id),
    identity,
    store,
    loadActive: () => store.loadActive(config.heartbeatRequiresWebhook),
  });
  const listings = new ListingService({
    store,
    identity,
    agentDns,
    heartbeats,
    publicUrl: config.publicUrl,
    heartbeatRequiresWebhook: config.heartbeatRequiresWebhook,
  });
  services = { config, store, identity, heartbeats, listings };
  return services;
}

export function resetServices(): void {
  services?.heartbeats.shutdown();
  services = undefined;
}
