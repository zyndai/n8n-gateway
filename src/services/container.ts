// Lazy composition root. Nothing here runs at import time, so tests and /health never need a
// database, secrets or an AgentDNS connection.
import { loadConfig, type Config } from '../config.js';
import { getDb } from '../db/client.js';
import { A2AHandler } from './A2AHandler.js';
import { AgentCardService } from './AgentCard.js';
import { AgentWalletStore } from './AgentWalletStore.js';
import { AgentCaller } from './AgentCaller.js';
import { AgentDnsClient } from './AgentDnsClient.js';
import { ApiKeyService } from './ApiKeyService.js';
import { ApiKeyStore } from './ApiKeyStore.js';
import { UsdBalanceReader, defaultRpcUrl } from './BalanceReader.js';
import { Cluster, parsePeers } from './Cluster.js';
import { HeartbeatCoordinator } from './HeartbeatCoordinator.js';
import { HeartbeatManager } from './HeartbeatManager.js';
import { IdentityService } from './IdentityService.js';
import { ListingService } from './ListingService.js';
import { ListingStore } from './ListingStore.js';
import { NonceStore } from './NonceStore.js';
import { PaymentProcessor } from './PaymentProcessor.js';
import { PaymentProofVault, PaymentRecovery } from './PaymentRecovery.js';
import { TaskStore } from './TaskStore.js';
import { WalletService } from './WalletService.js';
import { WebhookForwarder } from './WebhookForwarder.js';
import { parseMasterKey } from './keyVault.js';

export interface Services {
  config: Config;
  store: ListingStore;
  identity: IdentityService;
  heartbeats: HeartbeatManager;
  cluster: Cluster;
  coordinator: HeartbeatCoordinator;
  listings: ListingService;
  agentDns: AgentDnsClient;
  apiKeys: ApiKeyStore;
  apiKeySvc: ApiKeyService;
  wallet: WalletService;
  tasks: TaskStore;
  nonces: NonceStore;
  payments: PaymentProcessor;
  recovery: PaymentRecovery;
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
  });
  // M5.3: with no peers this instance owns every listing, exactly as before.
  const coordinatorRef: { current?: HeartbeatCoordinator } = {};
  const cluster = new Cluster({
    selfId: config.cluster.instanceId,
    peers: parsePeers(config.cluster.peers, config.cluster.instanceId),
    intervalMs: config.cluster.probeIntervalMs,
    failThreshold: config.cluster.failThreshold,
    // A peer died or came back: take over or hand back listings now instead of at the next interval.
    onChange: (live) => {
      console.log(`cluster: live instances ${live.join(', ')}`);
      void coordinatorRef.current?.reconcile().catch((err: unknown) => console.error('heartbeat reconcile failed', err));
    },
  });
  const coordinator = new HeartbeatCoordinator({
    manager: heartbeats,
    cluster,
    identity,
    loadActive: () => store.loadActive(config.heartbeatRequiresWebhook),
    log: console,
  });
  coordinatorRef.current = coordinator;
  const payments = new PaymentProcessor({ config: config.x402 });
  const rpcUrl = config.x402.rpcUrl ?? defaultRpcUrl(config.x402.network);
  if (!rpcUrl) console.warn(`No RPC endpoint for ${config.x402.network}: wallet balances stay empty until X402_RPC_URL is set`);
  const wallet = new WalletService({
    store,
    wallets: new AgentWalletStore(db),
    identity,
    payments,
    masterKey,
    balances: new UsdBalanceReader({ rpcUrl, asset: config.x402.asset, decimals: config.x402.assetDecimals }),
  });
  const listings = new ListingService({
    store,
    identity,
    agentDns,
    heartbeats: coordinator,
    publicUrl: config.publicUrl,
    heartbeatRequiresWebhook: config.heartbeatRequiresWebhook,
    masterKey,
    allowPrivateWebhooks: config.allowPrivateWebhooks,
    onCreated: (l) => wallet.ensureListingWallet(l),
  });

  const apiKeys = new ApiKeyStore(db);
  const tasks = new TaskStore(db);
  const nonces = new NonceStore(db);
  const vault = new PaymentProofVault(masterKey);
  const recovery = new PaymentRecovery({
    tasks,
    payments,
    vault,
    log: { info: (m) => console.log(m), error: (m, e) => console.error(m, e) },
  });
  const a2a = new A2AHandler({
    listings,
    tasks,
    payments,
    vault,
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
  services = { config, store, identity, heartbeats, cluster, coordinator, listings, agentDns, apiKeys, apiKeySvc, wallet, tasks, nonces, payments, recovery, a2a, caller, cards };
  return services;
}

export function resetServices(): void {
  services?.coordinator.end();
  services?.cluster.stop();
  services?.heartbeats.shutdown();
  services = undefined;
}
