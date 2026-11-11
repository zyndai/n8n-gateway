import express, { type Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createCardRouter, type CardDeps } from './routes/card.js';
import { createA2aRouter, type A2aDeps } from './routes/a2a.js';
import { createDashboardRouter, type DashboardDeps } from './routes/dashboard.js';
import { Metrics, metricsHandler } from './observability/metrics.js';
import { healthRouter } from './routes/health.js';
import { RateLimiter } from './services/RateLimiter.js';
import { createN8nRouter, type N8nDeps } from './routes/n8n.js';
import { getServices } from './services/container.js';
import type { ListingService } from './services/ListingService.js';

export interface AppDeps {
  config?: Pick<Config, 'sessionJwtSecret'> & Partial<Pick<Config, 'metricsToken' | 'rateLimit'>>;
  /** M5.2: the per-key limiter for /n8n/v1/*. Defaults to one built from `config.rateLimit`. */
  rateLimiter?: RateLimiter;
  /** M5.1: recorded for every request and served at /metrics when a token is configured. */
  metrics?: Metrics;
  /** Resolved per request so the app can boot without a database. Defaults to the real services. */
  listings?: () => ListingService;
  dashboard?: Partial<Pick<DashboardDeps, 'apiKeys' | 'tasks' | 'wallet'>>;
  /** Per-route-group overrides; each defaults to the real services, resolved per request. */
  n8n?: Partial<N8nDeps>;
  a2a?: Partial<A2aDeps>;
  card?: Partial<CardDeps>;
}

export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  const config = deps.config ?? loadConfig();
  const metrics = deps.metrics ?? new Metrics();
  const rateLimiter = deps.rateLimiter ?? new RateLimiter(config.rateLimit ?? loadConfig().rateLimit);
  app.use(metrics.middleware());
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);
  // Without METRICS_TOKEN there is no /metrics route at all.
  if (config.metricsToken) app.get('/metrics', metricsHandler(metrics, config.metricsToken));
  const listings = deps.listings ?? (() => getServices().listings);
  app.use(
    '/n8n/v1',
    createN8nRouter({
      apiKeys: () => getServices().apiKeys,
      agentDns: () => getServices().agentDns,
      listings,
      caller: () => getServices().caller,
      airnode: () => getServices().airnode,
      a2a: () => getServices().a2a,
      rateLimiter: () => rateLimiter,
      ...deps.n8n,
    }),
  );
  app.use(
    '/a/:entityId/a2a/v1',
    createA2aRouter({ a2a: () => getServices().a2a, nonces: () => getServices().nonces, ...deps.a2a }),
  );
  app.use('/a/:entityId/.well-known/agent-card.json', createCardRouter({ cards: () => getServices().cards, ...deps.card }));
  app.use(
    '/internal/v1',
    createDashboardRouter({
      config,
      listings,
      apiKeys: () => getServices().apiKeySvc,
      tasks: () => getServices().tasks,
      wallet: () => getServices().wallet,
      ...deps.dashboard,
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
