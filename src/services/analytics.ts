// M6.2: roll daily per-listing stats up into per-listing totals for the dashboard charts.
import type { DailyStat } from './TaskStore.js';
import { formatUsd, parseUsd } from './money.js';

export interface ListingTotals {
  listingId: string | null;
  calls: number;
  completed: number;
  failed: number;
  /** failed / (completed + failed); null while nothing has finished. Cancelled calls are left out. */
  errorRate: number | null;
  revenueUsd: string;
}

export function summarizeAnalytics(series: DailyStat[]): { series: DailyStat[]; totals: ListingTotals[] } {
  const by = new Map<string, { t: ListingTotals; micro: bigint }>();
  for (const d of series) {
    const k = d.listingId ?? '';
    const e = by.get(k) ?? { t: { listingId: d.listingId, calls: 0, completed: 0, failed: 0, errorRate: null, revenueUsd: '' }, micro: 0n };
    e.t.calls += d.calls;
    e.t.completed += d.completed;
    e.t.failed += d.failed;
    e.micro += parseUsd(d.revenueUsd);
    by.set(k, e);
  }
  const totals = [...by.values()].map(({ t, micro }) => {
    const finished = t.completed + t.failed;
    return { ...t, errorRate: finished === 0 ? null : t.failed / finished, revenueUsd: formatUsd(micro) };
  });
  totals.sort((a, b) => b.calls - a.calls);
  return { series, totals };
}
