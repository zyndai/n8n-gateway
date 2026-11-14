import { describe, expect, it } from 'vitest';
import { formatUsd, sumUsd, timeAgo } from '@/lib/format';
import { STUDIO_TAG, agentStatus } from '@/lib/status';
import { initials } from '@/components/account-menu';

describe('formatUsd', () => {
  it('formats money', () => {
    expect(formatUsd('0.5')).toBe('$0.50');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd('0.0025')).toBe('$0.0025');
  });
  it('never shows NaN', () => {
    for (const v of [null, undefined, '', 'abc', NaN]) expect(formatUsd(v as string)).toBe('—');
  });
});

describe('sumUsd', () => {
  it('adds what is known and ignores what is not', () => {
    expect(sumUsd(['1.00', null, '0.84', undefined, 'x'])).toBe('1.840000');
  });
  it('is null when nothing could be read', () => {
    expect(sumUsd([null, undefined])).toBeNull();
    expect(sumUsd([])).toBeNull();
  });
});

describe('timeAgo', () => {
  const now = Date.UTC(2026, 10, 16, 12);
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('speaks plainly', () => {
    expect(timeAgo(ago(10_000), now)).toBe('just now');
    expect(timeAgo(ago(60_000), now)).toBe('1 minute ago');
    expect(timeAgo(ago(13 * 60_000), now)).toBe('13 minutes ago');
    expect(timeAgo(ago(2 * 3600_000), now)).toBe('2 hours ago');
    expect(timeAgo(ago(26 * 3600_000), now)).toBe('1 day ago');
  });
});

describe('agentStatus', () => {
  it('maps Gateway statuses to Draft, Live and Paused', () => {
    expect(agentStatus('DRAFT')).toBe('draft');
    expect(agentStatus('REGISTERING')).toBe('draft');
    expect(agentStatus('ACTIVE')).toBe('live');
    expect(agentStatus('INACTIVE')).toBe('paused');
    expect(agentStatus('ERROR')).toBe('paused');
    expect(STUDIO_TAG).toBe('zynd-studio');
  });
});

describe('initials', () => {
  it('uses the first and last name', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Grace Brewster Hopper')).toBe('GH');
    expect(initials('Plato')).toBe('P');
    expect(initials('')).toBe('?');
  });
});
