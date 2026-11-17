import { Skeleton } from '@/components/ui/skeleton';

/** Shown the moment a person opens an agent, while its details, activity and network are read. */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading your agent">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Skeleton className="h-[28rem] rounded-xl" />
        <Skeleton className="hidden h-[28rem] rounded-xl lg:block" />
      </div>
    </div>
  );
}
