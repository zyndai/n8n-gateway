import { describe, expect, it } from 'vitest';
import { signThread, verifyThread } from '@/lib/builder/thread';

const SECRET = 'thread-test-secret-0123456789abcdef0123';
describe('builder thread tokens', () => {
  const token = signThread(SECRET, 'user-1', 'agent-1', 'resp_abc123', 1_000);
  it('give back the response id to the same person and agent', () => {
    expect(verifyThread(SECRET, 'user-1', 'agent-1', token, 2_000)).toBe('resp_abc123');
  });
  it('refuse another person, another agent, another secret, a changed id or an old token', () => {
    expect(verifyThread(SECRET, 'user-2', 'agent-1', token, 2_000)).toBeNull();
    expect(verifyThread(SECRET, 'user-1', 'agent-2', token, 2_000)).toBeNull();
    expect(verifyThread('another-secret-0123456789abcdef01234567', 'user-1', 'agent-1', token, 2_000)).toBeNull();
    expect(verifyThread(SECRET, 'user-1', 'agent-1', token.replace('resp_abc123', 'resp_someoneelse'), 2_000)).toBeNull();
    expect(verifyThread(SECRET, 'user-1', 'agent-1', token, 1_000 + 30 * 24 * 3600_000)).toBeNull();
  });
  it('treat junk as no thread', () => {
    for (const junk of [undefined, null, '', 'x', 'a.b.c', 42, 'resp.9999999999999.', 'x'.repeat(500)]) expect(verifyThread(SECRET, 'user-1', 'agent-1', junk, 2_000)).toBeNull();
  });
});
