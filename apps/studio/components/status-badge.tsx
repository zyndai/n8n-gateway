import { Badge } from '@/components/ui/badge';
import { copy } from '@/lib/copy';
import type { AgentStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const styles: Record<AgentStatus, string> = {
  draft: 'border-border bg-secondary text-secondary-foreground',
  live: 'border-transparent bg-success-soft text-success',
  paused: 'border-transparent bg-warning-soft text-warning',
};

export function StatusBadge({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', styles[status], className)}>
      <span className={cn('size-1.5 rounded-full', status === 'live' ? 'bg-success' : status === 'paused' ? 'bg-warning' : 'bg-muted-foreground/60')} aria-hidden />
      {copy.status[status]}
    </Badge>
  );
}
