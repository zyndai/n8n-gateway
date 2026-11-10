// `/a/:entityId/.well-known/agent-card.json`: the signed A2A Agent Card of a listing (G20, M2.19).
import { Router } from 'express';
import type { AgentCardService } from '../services/AgentCard.js';

export interface CardDeps {
  cards: () => Pick<AgentCardService, 'build'>;
}

export function createCardRouter(deps: CardDeps): Router {
  const router = Router({ mergeParams: true });
  router.get('/', async (req, res) => {
    const card = await deps.cards().build((req.params as Record<string, string>).entityId as string);
    res.set('Cache-Control', 'public, max-age=60').json(card);
  });
  return router;
}
