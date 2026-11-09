import { notImplemented } from './notImplemented.js';

/** LLD > A2AHandler. Implemented in M2.9-M2.12. */
export class A2AHandler {
  async tasksSend(_entityId: string, _request: unknown): Promise<unknown> {
    return notImplemented('A2AHandler.tasksSend', 'M2.9');
  }

  async tasksGet(_entityId: string, _taskId: string): Promise<unknown> {
    return notImplemented('A2AHandler.tasksGet', 'M2.10');
  }

  async tasksCancel(_entityId: string, _taskId: string): Promise<unknown> {
    return notImplemented('A2AHandler.tasksCancel', 'M2.10');
  }
}
