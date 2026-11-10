CREATE TABLE "n8n_agent_wallet" (
	"id" text PRIMARY KEY NOT NULL,
	"listingId" text,
	"developerId" text NOT NULL,
	"derivedKeyIndex" integer NOT NULL,
	"address" text NOT NULL,
	"privateKeyEnc" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "n8n_agent_wallet" ADD CONSTRAINT "n8n_agent_wallet_listingId_n8n_listing_id_fk" FOREIGN KEY ("listingId") REFERENCES "public"."n8n_listing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "n8n_agent_wallet" ADD CONSTRAINT "n8n_agent_wallet_developerId_developer_keys_developer_id_fk" FOREIGN KEY ("developerId") REFERENCES "public"."developer_keys"("developer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "n8n_agent_wallet_listingId_key" ON "n8n_agent_wallet" USING btree ("listingId");--> statement-breakpoint
CREATE UNIQUE INDEX "n8n_agent_wallet_developerId_derivedKeyIndex_key" ON "n8n_agent_wallet" USING btree ("developerId","derivedKeyIndex");--> statement-breakpoint
CREATE UNIQUE INDEX "n8n_agent_wallet_address_key" ON "n8n_agent_wallet" USING btree ("address");--> statement-breakpoint
CREATE INDEX "n8n_agent_wallet_developerId_idx" ON "n8n_agent_wallet" USING btree ("developerId");