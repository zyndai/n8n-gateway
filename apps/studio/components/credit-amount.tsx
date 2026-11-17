import { totalCredit } from '@/lib/data';
import { copy } from '@/lib/copy';
import { formatUsd } from '@/lib/format';
import type { StudioSession } from '@/lib/session-cookie';

/** The total credit, read on its own so the page does not wait for the Gateway and the chain to draw the top bar. */
export async function CreditAmount({ session }: { session: StudioSession }) {
  const credit = await totalCredit(session);
  return (
    <span className="font-medium tabular-nums" title={credit === null ? copy.account.unknownCredit : undefined}>
      {formatUsd(credit)}
    </span>
  );
}
