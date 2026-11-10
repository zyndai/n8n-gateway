// In-process wake-up for tasks (G2). A waiting `tasks/send` sleeps on the task id and is woken the
// moment `jobs/complete` (or a cancel) lands, so a synchronous call is not rounded up to the
// 2 s poll tick. The poll stays as the fallback, so a missed wake-up costs at most one tick.
export class TaskWaiter {
  private readonly waiters = new Map<string, Set<() => void>>();

  /** Resolves on `notify(taskId)` or after `ms`, whichever comes first. */
  wait(taskId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(taskId) ?? new Set<() => void>();
      this.waiters.set(taskId, set);
      const finish = (): void => {
        clearTimeout(timer);
        set.delete(finish);
        if (set.size === 0) this.waiters.delete(taskId);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      set.add(finish);
    });
  }

  notify(taskId: string): void {
    for (const wake of [...(this.waiters.get(taskId) ?? [])]) wake();
  }

  get size(): number {
    return this.waiters.size;
  }
}
