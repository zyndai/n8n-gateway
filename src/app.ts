import express, { type Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { a2aRouter } from './routes/a2a.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { healthRouter } from './routes/health.js';
import { n8nRouter } from './routes/n8n.js';
import { getServices } from './services/container.js';
import type { ListingService } from './services/ListingService.js';

export interface AppDeps {
  config?: Pick<Config, 'sessionJwtSecret'>;
  /** Resolved per request so the app can boot without a database. Defaults to the real services. */
  listings?: () => ListingService;
}

export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter);
  app.use('/n8n/v1', n8nRouter);
  app.use('/a/:entityId/a2a/v1', a2aRouter);
  app.use(
    '/internal/v1',
    createDashboardRouter({
      config: deps.config ?? loadConfig(),
      listings: deps.listings ?? (() => getServices().listings),
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
