// Gateway-owned tables (LLD > Database Schema). This is the only file drizzle-kit reads.
// `developerKey` is imported for foreign keys but deliberately not re-exported, so it never
// lands in a Gateway migration.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { developerKey } from './dashboard.js';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());
const ts = (name: string) => timestamp(name, { precision: 3 });
const createdAt = () => ts('createdAt').notNull().defaultNow();
const updatedAt = () =>
  ts('updatedAt')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const usd = (name: string) => numeric(name, { precision: 18, scale: 6 });

export const listingStatus = pgEnum('N8nListingStatus', [
  'DRAFT',
  'REGISTERING',
  'ACTIVE',
  'INACTIVE',
  'ERROR',
]);
export const taskDirection = pgEnum('N8nTaskDirection', ['INBOUND', 'OUTBOUND']);
export const taskStatus = pgEnum('N8nTaskStatus', [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'TIMEOUT',
  'CANCELED', // G6: tasks/cancel
]);
// G8: STOPPED is a deliberate stop(), distinct from FAILED.
export const heartbeatStatus = pgEnum('N8nHeartbeatStatus', [
  'CONNECTING',
  'ACTIVE',
  'RECONNECTING',
  'FAILED',
  'STOPPED',
]);

export const n8nApiKey = pgTable(
  'n8n_api_key',
  {
    id: id(),
    developerId: text('developerId')
      .notNull()
      .references(() => developerKey.developerId),
    name: text('name').notNull(),
    keyHash: text('keyHash').notNull(), // SHA-256 of the plaintext key
    keyPrefix: text('keyPrefix').notNull(), // first 8 chars, for display
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`ARRAY['search', 'call', 'complete']::text[]`),
    spendCapUsd: usd('spendCapUsd'),
    spentUsd: usd('spentUsd').notNull().default('0'),
    expiresAt: ts('expiresAt'),
    lastUsedAt: ts('lastUsedAt'),
    revokedAt: ts('revokedAt'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('n8n_api_key_keyHash_key').on(t.keyHash), index('n8n_api_key_developerId_idx').on(t.developerId)],
);

export const n8nListing = pgTable(
  'n8n_listing',
  {
    id: id(),
    developerId: text('developerId')
      .notNull()
      .references(() => developerKey.developerId),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    category: text('category').notNull(),
    tags: text('tags').array().notNull(),
    entityId: text('entityId'), // AgentDNS entity id, set after registration
    // G13: allocated from n8nDerivationCounter; monotonic, never reused.
    derivedKeyIndex: integer('derivedKeyIndex').notNull(),
    webhookUrl: text('webhookUrl'),
    // G1: the Gateway replays the secret in plaintext, so it is stored encrypted (AES-256-GCM), not hashed.
    webhookSecretEnc: text('webhookSecretEnc'),
    workflowId: text('workflowId'),
    // G17: per-listing price of one inbound call. Null = use the Gateway default (X402_INBOUND_PRICE_USD); 0 = free.
    priceUsd: usd('priceUsd'),
    status: listingStatus('status').notNull().default('DRAFT'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('n8n_listing_entityId_key').on(t.entityId),
    uniqueIndex('n8n_listing_developerId_derivedKeyIndex_key').on(t.developerId, t.derivedKeyIndex),
    index('n8n_listing_developerId_idx').on(t.developerId),
    index('n8n_listing_status_idx').on(t.status),
  ],
);

export const n8nTask = pgTable(
  'n8n_task',
  {
    id: id(),
    // G3: outbound tasks are signed with the developer's master key and may have no listing.
    developerId: text('developerId')
      .notNull()
      .references(() => developerKey.developerId),
    listingId: text('listingId').references(() => n8nListing.id, { onDelete: 'set null' }),
    apiKeyId: text('apiKeyId').references(() => n8nApiKey.id, { onDelete: 'set null' }), // outbound only
    callerId: text('callerId'), // entity id of the calling agent (inbound)
    direction: taskDirection('direction').notNull(),
    input: jsonb('input').notNull(),
    output: jsonb('output'),
    status: taskStatus('status').notNull().default('PENDING'),
    paymentTxn: text('paymentTxn'),
    paymentUsd: usd('paymentUsd'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('n8n_task_developerId_createdAt_idx').on(t.developerId, t.createdAt),
    index('n8n_task_listingId_createdAt_idx').on(t.listingId, t.createdAt),
    index('n8n_task_status_idx').on(t.status),
  ],
);

export const n8nHeartbeat = pgTable(
  'n8n_heartbeat',
  {
    id: id(),
    listingId: text('listingId')
      .notNull()
      .references(() => n8nListing.id, { onDelete: 'cascade' }),
    status: heartbeatStatus('status').notNull().default('CONNECTING'),
    lastBeatAt: ts('lastBeatAt'),
    failCount: integer('failCount').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('n8n_heartbeat_listingId_key').on(t.listingId)],
);

// G13: per-developer allocator for derivedKeyIndex. Increment atomically
// (INSERT ... ON CONFLICT DO UPDATE SET nextIndex = nextIndex + 1 RETURNING) so concurrent
// creates never share an index, and deleting a listing never frees one.
export const n8nDerivationCounter = pgTable(
  'n8n_derivation_counter',
  {
    developerId: text('developerId').primaryKey(),
    nextIndex: integer('nextIndex').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Explicit name: the generated one exceeds Postgres' 63-character identifier limit.
    foreignKey({
      name: 'n8n_derivation_counter_developerId_fk',
      columns: [t.developerId],
      foreignColumns: [developerKey.developerId],
    }),
  ],
);

// G5: replay-protection store for x-zynd-auth nonces. The primary key makes "seen before" an
// atomic insert; rows past expiresAt are purged periodically.
export const n8nNonce = pgTable(
  'n8n_nonce',
  {
    nonce: text('nonce').primaryKey(),
    expiresAt: ts('expiresAt').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('n8n_nonce_expiresAt_idx').on(t.expiresAt)],
);
