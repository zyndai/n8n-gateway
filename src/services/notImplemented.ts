import { ApiError } from '../errors.js';

export function notImplemented(what: string, milestone: string): never {
  throw new ApiError('NOT_IMPLEMENTED', `${what} lands in ${milestone}`);
}
