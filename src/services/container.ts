// Lazy composition root. Nothing here runs at import time, so tests and /health never need a
// database, secrets or an AgentDNS connection.
import { loadConfig, type Config } from '../config.js';
import { getDb } from '../db/client.js';
import { A2AHandler } from './A2AHandler.js';
import { AgentCardService } from './AgentCard.js';
import { AgentCaller } from './AgentCaller.js';
import { AgentDnsClient } from './AgentDnsClient.js';
import { ApiKeyService } from './ApiKeyService.js';
import { ApiKeyStore } from './ApiKeyStore.js';
import { HeartbeatManager } from './HeartbeatManager.js';
import { IdentityService } from './IdentityService.js';
import { ListingService } from './ListingService.js';
import { ListingStore } from './ListingStore.js';
import { NonceStore } from './NonceStore.js';
import { PaymentProcessor } from './PaymentProcessor.js';
import { TaskStore } from './TaskStore.js';
import { WalletService } from './WalletService.js';
import { WebhookForwarder } from './WebhookForwarder.js';
import { parseMasterKey } from './keyVault.js';

export interface Services {
  config: Config;
  store: ListingStore;
  identity: IdentityService;
  heartbeats: HeartbeatManager;
  listings: ListingService;
  agentDns: AgentDnsClient;
  apiKeys: ApiKeyStore;
  apiKeySvc: ApiKeyService;
  wallet: WalletService;
  tasks: TaskStore;
  nonces: NonceStore;
  payments: PaymentProcessor;
  a2a: A2AHandler;
  caller: AgentCaller;
  cards: AgentCardService;
}

let services: Services | undefined;

export function getServices(): Services {
  if (services) return services;
  const config = loadConfig();
  const db = getDb();
  const store = new ListingStore(db);
  const masterKey = parseMasterKey(config.pkiEncryptionKey);
  const identity = new IdentityService({ masterKey, keySource: store });
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
    masterKey,
    allowPrivateWebhooks: config.allowPrivateWebhooks,
  });

  const apiKeys = new ApiKeyStore(db);
  const tasks = new TaskStore(db);
  const nonces = new NonceStore(db);
  const payments = new PaymentProcessor({ config: config.x402 });
  const a2a = new A2AHandler({
    listings,
    tasks,
    payments,
    identity,
    forwarder: new WebhookForwarder(),
    inboundPriceUsd: config.x402.inboundPriceUsd,
    publicUrl: config.publicUrl,
  });
  const caller = new AgentCaller({ agentDns, identity, payments, tasks, apiKeys, defaultMaxPaymentUsd: config.x402.defaultMaxPaymentUsd });
  const cards = new AgentCardService({
    listings,
    identity,
    payments,
    publicUrl: config.publicUrl,
    registryUrl: config.agentDnsUrl,
    defaultPriceUsd: config.x402.inboundPriceUsd,
  });
  const apiKeySvc = new ApiKeyService({ store: apiKeys, developerExists: (id) => store.developerExists(id) });
  const wallet = new WalletService({ store, identity, payments });
  services = { config, store, identity, heartbeats, listings, agentDns, apiKeys, apiKeySvc, wallet, tasks, nonces, payments, a2a, caller, cards };
  return services;
}

export function resetServices(): void {
  services?.heartbeats.shutdown();
  services = undefined;
}
