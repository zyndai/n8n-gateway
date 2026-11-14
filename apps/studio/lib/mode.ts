import 'server-only';
import { builderConfigured, isPreview } from './env';
import type { BuilderMode } from './types';

/** Scripted sample data in preview, the real builder and agents once configured, otherwise "not switched on yet". */
export function appMode(): BuilderMode {
  if (isPreview()) return 'preview';
  return builderConfigured() ? 'live' : 'off';
}
