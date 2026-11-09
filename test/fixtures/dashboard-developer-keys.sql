-- The dashboard-owned table the Gateway reads and references (dashboard/prisma/schema.prisma,
-- model DeveloperKey, @@map("developer_keys")). Test databases need it before `db:migrate`,
-- because every n8n_* table has a foreign key to developer_keys.developer_id. Production already
-- has it from the dashboard's own migrations; never run this there.
CREATE TABLE IF NOT EXISTS "developer_keys" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "developer_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key_enc" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "role" TEXT,
    "registration_ip" TEXT,
    "country" TEXT,
    "evm_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "developer_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "developer_keys_user_id_key" ON "developer_keys"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "developer_keys_developer_id_key" ON "developer_keys"("developer_id");
