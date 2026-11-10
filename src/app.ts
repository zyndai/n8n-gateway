import express, { type Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createCardRouter, type CardDeps } from './routes/card.js';
import { createA2aRouter, type A2aDeps } from './routes/a2a.js';
import { createDashboardRouter, type DashboardDeps } from './routes/dashboard.js';
import { healthRouter } from './routes/health.js';
import { createN8nRouter, type N8nDeps } from './routes/n8n.js';
import { getServices } from './services/container.js';
import type { ListingService } from './services/ListingService.js';

export interface AppDeps {
  config?: Pick<Config, 'sessionJwtSecret'>;
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
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);
  const listings = deps.listings ?? (() => getServices().listings);
  app.use(
    '/n8n/v1',
    createN8nRouter({
      apiKeys: () => getServices().apiKeys,
      agentDns: () => getServices().agentDns,
      listings,
      caller: () => getServices().caller,
      a2a: () => getServices().a2a,
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
      config: deps.config ?? loadConfig(),
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
