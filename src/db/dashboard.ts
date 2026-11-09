// Dashboard-owned table, mirrored read-only so Drizzle can resolve foreign keys and read keys (G12).
// This file is NOT part of drizzle-kit's schema entry (see drizzle.config.ts), so the Gateway
// never generates or applies migrations for it. Keep the columns in step with the dashboard's
// Prisma model `DeveloperKey` (dashboard/prisma/schema.prisma, `@@map("developer_keys")`); only
// declare what the Gateway reads.
//
// There is no separate `Developer` table: a developer is a row here, identified by `developer_id`
// (`zns:dev:<hash>`, unique). Gateway tables reference that column.
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const developerKey = pgTable('developer_keys', {
  id: uuid('id').primaryKey(),
  // Supabase auth user that owns this developer identity.
  userId: text('user_id').notNull(),
  // Public developer identity, `zns:dev:<hex>`. Unique; the FK target for every n8n_* table.
  developerId: text('developer_id').notNull().unique(),
  // `ed25519:<base64>` or bare base64 public key of the developer master keypair.
  publicKey: text('public_key').notNull(),
  // base64(iv[12] || authTag[16] || ciphertext), AES-256-GCM under PKI_ENCRYPTION_KEY.
  // The plaintext is the base64 of the Ed25519 private key (32-byte seed, or 64-byte seed||public).
  privateKeyEnc: text('private_key_enc').notNull(),
  // NOT NULL in the dashboard schema; declared so inserts in tests are valid.
  name: text('name').notNull(),
});
