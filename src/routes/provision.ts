import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { ApiError } from '../errors.js';
import type { ProvisionedDeveloper } from '../services/ProvisionService.js';

export interface ProvisionDeps {
  /** `STUDIO_SERVICE_TOKEN`. Studio's server presents it as a bearer token. */
  token: string;
  provisioner: () => { provision(userId: string, name: string): Promise<ProvisionedDeveloper> };
}

/** A shared secret shorter than this is not accepted: the route is not mounted without a usable token. */
export const MIN_SERVICE_TOKEN_LEN = 32;

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

function serviceAuth(token: string): RequestHandler {
  const expected = digest(token);
  return (req, _res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    // Compare fixed-length digests so neither the length nor the content of the token leaks through timing.
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), expected)) {
      next(new ApiError('AUTH_INVALID', 'Invalid service token'));
      return;
    }
    next();
  };
}

/** Body of POST /internal/v1/provision: the Supabase user id and the display name from Google. */
export function parseProvisionBody(raw: unknown): { userId: string; name: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('BAD_REQUEST', 'Expected a JSON object');
  const { userId, name } = raw as Record<string, unknown>;
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 100) throw new ApiError('BAD_REQUEST', 'userId must be a non-empty string of at most 100 characters');
  if (name !== undefined && (typeof name !== 'string' || name.length > 200)) throw new ApiError('BAD_REQUEST', 'name must be a string of at most 200 characters');
  return { userId: userId.trim(), name: typeof name === 'string' ? name : '' };
}

/**
 * Zynd Studio's one write route on the Gateway. Mounted at `/internal/v1/provision`, before the dashboard
 * router: it is authenticated by the service token, not by a Session JWT, because the developer it names
 * may not exist yet. Idempotent: see ProvisionService.
 */
export function createProvisionRouter(deps: ProvisionDeps): Router {
  const router = Router();
  router.use(serviceAuth(deps.token));
  router.post('/', async (req, res) => {
    const { userId, name } = parseProvisionBody(req.body);
    const out = await deps.provisioner().provision(userId, name);
    res.status(out.created ? 201 : 200).json(out);
  });
  return router;
}
