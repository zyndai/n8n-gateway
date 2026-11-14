import express, { type Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { ApiError } from './errors.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createCardRouter, type CardDeps } from './routes/card.js';
import { createA2aRouter, type A2aDeps } from './routes/a2a.js';
import { createDashboardRouter, type DashboardDeps } from './routes/dashboard.js';
import { MIN_SERVICE_TOKEN_LEN, createProvisionRouter, type ProvisionDeps } from './routes/provision.js';
import { Metrics, metricsHandler } from './observability/metrics.js';
import { healthRouter } from './routes/health.js';
import { RateLimiter } from './services/RateLimiter.js';
import { createN8nRouter, type N8nDeps } from './routes/n8n.js';
import { getServices } from './services/container.js';
import type { ListingService } from './services/ListingService.js';

export interface AppDeps {
  config?: Pick<Config, 'sessionJwtSecret'> & Partial<Pick<Config, 'metricsToken' | 'rateLimit' | 'studioServiceToken'>>;
  /** M5.2: the per-key limiter for /n8n/v1/*. Defaults to one built from `config.rateLimit`. */
  rateLimiter?: RateLimiter;
  /** M5.1: recorded for every request and served at /metrics when a token is configured. */
  metrics?: Metrics;
  /** Resolved per request so the app can boot without a database. Defaults to the real services. */
  listings?: () => ListingService;
  dashboard?: Partial<Pick<DashboardDeps, 'apiKeys' | 'tasks' | 'wallet'>>;
  /** Per-route-group overrides; each defaults to the real services, resolved per request. */
  n8n?: Partial<N8nDeps>;
  /** Studio's provisioning route; `provisioner` defaults to the real service (and answers 503 when it is not configured). */
  provision?: Partial<Pick<ProvisionDeps, 'provisioner'>>;
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
  // Zynd Studio: authenticated by STUDIO_SERVICE_TOKEN, so it sits before the Session JWT router. Without
  // a usable token the route does not exist and /internal/v1/provision falls through to the JWT check.
  if (config.studioServiceToken && config.studioServiceToken.length >= MIN_SERVICE_TOKEN_LEN) {
    app.use(
      '/internal/v1/provision',
      createProvisionRouter({
        token: config.studioServiceToken,
        provisioner: () => {
          const p = getServices().provisioner;
          if (!p) throw new ApiError('GATEWAY_UNAVAILABLE', 'Studio provisioning is not configured on this Gateway');
          return p;
        },
        ...deps.provision,
      }),
    );
  } else if (config.studioServiceToken) {
    console.error(`STUDIO_SERVICE_TOKEN is shorter than ${MIN_SERVICE_TOKEN_LEN} characters: /internal/v1/provision is disabled`);
  }
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
