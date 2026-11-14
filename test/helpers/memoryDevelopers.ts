// In-memory DeveloperDirectory with the same rules as the Drizzle store: one developer per user, a unique handle,
// a handle set only while null.
import { DuplicateDeveloperError, type DeveloperDirectory, type DeveloperRecord, type NewDeveloper } from '../../src/services/DeveloperStore.js';

export class MemoryDevelopers implements DeveloperDirectory {
  byUser = new Map<string, DeveloperRecord>();
  async findByUserId(userId: string) {
    return this.byUser.get(userId);
  }
  async insert(dev: NewDeveloper) {
    if (this.byUser.has(dev.userId)) throw new DuplicateDeveloperError();
    const row = { ...dev, username: null };
    this.byUser.set(dev.userId, row);
    return row;
  }
  async usernameTaken(username: string) {
    return [...this.byUser.values()].some((d) => d.username === username);
  }
  async setUsername(userId: string, username: string) {
    const row = this.byUser.get(userId);
    if (!row || row.username) return 'already_set' as const;
    if (await this.usernameTaken(username)) return 'taken' as const;
    row.username = username;
    return 'ok' as const;
  }
}
