CREATE TABLE "balance_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"balance" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_snapshot_account_as_of_source_unique" UNIQUE("account_id","as_of","source")
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"institution_name" text,
	"institution_country" text,
	"status" text NOT NULL,
	"credentials_enc" text,
	"external_session_id_enc" text,
	"consent_expires_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"next_sync_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"manual_refreshes_today" integer DEFAULT 0 NOT NULL,
	"manual_refresh_day" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "connection_provider_check" CHECK ("connection"."provider" in ('enablebanking','trading212')),
	CONSTRAINT "connection_status_check" CHECK ("connection"."status" in ('pending','active','expired','error','revoked'))
);
--> statement-breakpoint
CREATE TABLE "connection_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"external_uid" text NOT NULL,
	"external_key" text NOT NULL,
	"currency" char(3) NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_account_connection_external_key_unique" UNIQUE("connection_id","external_key"),
	CONSTRAINT "connection_account_household_account_unique" UNIQUE("household_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "consent_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"connection_id" uuid,
	"user_id" text NOT NULL,
	"aspsp_name" text NOT NULL,
	"aspsp_country" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_state_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"instrument" text NOT NULL,
	"name" text,
	"quantity" numeric(28, 10) NOT NULL,
	"price_minor" bigint NOT NULL,
	"value_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_snapshot_account_as_of_instrument_unique" UNIQUE("account_id","as_of","instrument")
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"pending_replaced" integer DEFAULT 0 NOT NULL,
	"provider_calls" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "sync_run_trigger_check" CHECK ("sync_run"."trigger" in ('scheduled','manual','initial')),
	CONSTRAINT "sync_run_status_check" CHECK ("sync_run"."status" in ('running','success','partial','failed'))
);
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "ai_suggested_category_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "ai_confidence" real;--> statement-breakpoint
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_account" ADD CONSTRAINT "connection_account_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_account" ADD CONSTRAINT "connection_account_connection_fk" FOREIGN KEY ("connection_id","household_id") REFERENCES "public"."connection"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_account" ADD CONSTRAINT "connection_account_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_state" ADD CONSTRAINT "consent_state_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_state" ADD CONSTRAINT "consent_state_connection_fk" FOREIGN KEY ("connection_id","household_id") REFERENCES "public"."connection"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_snapshot" ADD CONSTRAINT "position_snapshot_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_snapshot" ADD CONSTRAINT "position_snapshot_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_connection_fk" FOREIGN KEY ("connection_id","household_id") REFERENCES "public"."connection"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_household_idx" ON "connection" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "connection_next_sync_idx" ON "connection" USING btree ("next_sync_at") WHERE "connection"."status" = 'active';--> statement-breakpoint
CREATE INDEX "consent_state_expires_idx" ON "consent_state" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_household_dedupe_key_unique" ON "notification" USING btree ("household_id","dedupe_key") WHERE "notification"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notification_household_created_idx" ON "notification" USING btree ("household_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_run_connection_started_idx" ON "sync_run" USING btree ("connection_id","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_ai_suggested_category_fk" FOREIGN KEY ("ai_suggested_category_id","household_id") REFERENCES "public"."category"("id","household_id") ON DELETE no action ON UPDATE no action;