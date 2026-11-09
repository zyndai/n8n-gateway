import { notImplemented } from './notImplemented.js';

/** LLD > WebhookForwarder. Implemented in M2.8. */
export class WebhookForwarder {
  async forward(_webhookUrl: string, _secret: string, _task: unknown): Promise<void> {
    return notImplemented('WebhookForwarder.forward', 'M2.8');
  }
}
