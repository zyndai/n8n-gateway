import { notImplemented } from './notImplemented.js';

/** LLD > PaymentProcessor. Implemented in M2.7 and M2.13. */
export class PaymentProcessor {
  async verifyX402(_headers: Record<string, string | undefined>, _body: unknown): Promise<boolean> {
    return notImplemented('PaymentProcessor.verifyX402', 'M2.7');
  }

  signX402(_devPrivateKey: Uint8Array, _amountUsd: string, _recipient: string): Record<string, string> {
    return notImplemented('PaymentProcessor.signX402', 'M2.13');
  }

  deriveEvmKey(_ed25519PrivateKey: Uint8Array): Uint8Array {
    return notImplemented('PaymentProcessor.deriveEvmKey', 'M2.13');
  }
}
