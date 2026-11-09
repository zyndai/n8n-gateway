CREATE TYPE "public"."N8nHeartbeatStatus" AS ENUM('CONNECTING', 'ACTIVE', 'RECONNECTING', 'FAILED', 'STOPPED');--> statement-breakpoint
CREATE TYPE "public"."N8nListingStatus" AS ENUM('DRAFT', 'REGISTERING', 'ACTIVE', 'INACTIVE', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."N8nTaskDirection" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."N8nTaskStatus" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'TIMEOUT');--> statement-breakpoint
CREATE TABLE "n8n_api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"developerId" text NOT NULL,
	"name" text NOT NULL,
	"keyHash" text NOT NULL,
	"keyPrefix" text NOT NULL,
	"permissions" text[] DEFAULT ARRAY['search', 'call', 'complete']::text[] NOT NULL,
	"spendCapUsd" numeric(18, 6),
	"spentUsd" numeric(18, 6) DEFAULT '0' NOT NULL,
	"expiresAt" timestamp (3),
	"lastUsedAt" timestamp (3),
	"revokedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "n8n_derivation_counter" (
	"developerId" text PRIMARY KEY NOT NULL,
	"nextIndex" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "n8n_heartbeat" (
	"id" text PRIMARY KEY NOT NULL,
	"listingId" text NOT NULL,
	"status" "N8nHeartbeatStatus" DEFAULT 'CONNECTING' NOT NULL,
	"lastBeatAt" timestamp (3),
	"failCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "n8n_listing" (
	"id" text PRIMARY KEY NOT NULL,
	"developerId" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] NOT NULL,
	"entityId" text,
	"derivedKeyIndex" integer NOT NULL,
	"webhookUrl" text,
	"webhookSecretEnc" text,
	"workflowId" text,
	"status" "N8nListingStatus" DEFAULT 'DRAFT' NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "n8n_nonce" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "n8n_task" (
	"id" text PRIMARY KEY NOT NULL,
	"developerId" text NOT NULL,
	"listingId" text,
	"apiKeyId" text,
	"callerId" text,
	"direction" "N8nTaskDirection" NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"status" "N8nTaskStatus" DEFAULT 'PENDING' NOT NULL,
	"paymentTxn" text,
	"paymentUsd" numeric(18, 6),
	"error" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "n8n_api_key" ADD CONSTRAINT "n8n_api_key_developerId_developer_keys_developer_id_fk" FOREIGN KEY ("developerId") REFERENCES "public"."developer_keys"("developer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_derivation_counter" ADD CONSTRAINT "n8n_derivation_counter_developerId_fk" FOREIGN KEY ("developerId") REFERENCES "public"."developer_keys"("developer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_heartbeat" ADD CONSTRAINT "n8n_heartbeat_listingId_n8n_listing_id_fk" FOREIGN KEY ("listingId") REFERENCES "public"."n8n_listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_listing" ADD CONSTRAINT "n8n_listing_developerId_developer_keys_developer_id_fk" FOREIGN KEY ("developerId") REFERENCES "public"."developer_keys"("developer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_task" ADD CONSTRAINT "n8n_task_developerId_developer_keys_developer_id_fk" FOREIGN KEY ("developerId") REFERENCES "public"."developer_keys"("developer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_task" ADD CONSTRAINT "n8n_task_listingId_n8n_listing_id_fk" FOREIGN KEY ("listingId") REFERENCES "public"."n8n_listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_task" ADD CONSTRAINT "n8n_task_apiKeyId_n8n_api_key_id_fk" FOREIGN KEY ("apiKeyId") REFERENCES "public"."n8n_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "n8n_api_key_keyHash_key" ON "n8n_api_key" USING btree ("keyHash");--> statement-breakpoint
CREATE INDEX "n8n_api_key_developerId_idx" ON "n8n_api_key" USING btree ("developerId");--> statement-breakpoint
CREATE UNIQUE INDEX "n8n_heartbeat_listingId_key" ON "n8n_heartbeat" USING btree ("listingId");--> statement-breakpoint
CREATE UNIQUE INDEX "n8n_listing_entityId_key" ON "n8n_listing" USING btree ("entityId");--> statement-breakpoint
CREATE UNIQUE INDEX "n8n_listing_developerId_derivedKeyIndex_key" ON "n8n_listing" USING btree ("developerId","derivedKeyIndex");--> statement-breakpoint
CREATE INDEX "n8n_listing_developerId_idx" ON "n8n_listing" USING btree ("developerId");--> statement-breakpoint
CREATE INDEX "n8n_listing_status_idx" ON "n8n_listing" USING btree ("status");--> statement-breakpoint
CREATE INDEX "n8n_nonce_expiresAt_idx" ON "n8n_nonce" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "n8n_task_developerId_createdAt_idx" ON "n8n_task" USING btree ("developerId","createdAt");--> statement-breakpoint
CREATE INDEX "n8n_task_listingId_createdAt_idx" ON "n8n_task" USING btree ("listingId","createdAt");--> statement-breakpoint
CREATE INDEX "n8n_task_status_idx" ON "n8n_task" USING btree ("status");