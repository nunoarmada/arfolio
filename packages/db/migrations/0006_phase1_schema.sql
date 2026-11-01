CREATE TABLE "financial_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"institution_name" text,
	"iban_last4" text,
	"opening_balance" bigint DEFAULT 0 NOT NULL,
	"opening_balance_date" date,
	"include_in_budget" boolean DEFAULT true NOT NULL,
	"include_in_net_worth" boolean DEFAULT true NOT NULL,
	"connection_id" uuid,
	"external_id" text,
	"archived_at" timestamp with time zone,
	"sort" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_account_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "financial_account_type_check" CHECK ("financial_account"."type" in ('checking','savings','card','investment','meal_benefit','cash','loan','other'))
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"sort" smallint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"template_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_id_household_unique" UNIQUE("id","household_id")
);
--> statement-breakpoint
CREATE TABLE "category_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"sort" smallint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"template_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_group_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "category_group_kind_check" CHECK ("category_group"."kind" in ('income','expense','saving','transfer'))
);
--> statement-breakpoint
CREATE TABLE "merchant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"default_category_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "merchant_household_key_unique" UNIQUE("household_id","key")
);
--> statement-breakpoint
CREATE TABLE "rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"condition" jsonb NOT NULL,
	"category_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"filename" text NOT NULL,
	"preset_key" text,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_duplicate" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batch_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "import_batch_source_check" CHECK ("import_batch"."source" in ('csv','ofx','xlsx'))
);
--> statement-breakpoint
CREATE TABLE "import_preset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_preset_household_name_unique" UNIQUE("household_id","name"),
	CONSTRAINT "import_preset_kind_check" CHECK ("import_preset"."kind" in ('csv','xlsx'))
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text,
	"dedupe_hash" text NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text NOT NULL,
	"raw_description" text NOT NULL,
	"counterparty" text,
	"merchant_id" uuid,
	"category_id" uuid,
	"categorised_by" text,
	"confidence" real,
	"needs_review" boolean DEFAULT false NOT NULL,
	"transfer_group_id" uuid,
	"notes" text,
	"source" text NOT NULL,
	"import_batch_id" uuid,
	"user_edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_status_check" CHECK ("transaction"."status" in ('pending','booked')),
	CONSTRAINT "transaction_categorised_by_check" CHECK ("transaction"."categorised_by" is null or "transaction"."categorised_by" in ('rule','memory','ai','user')),
	CONSTRAINT "transaction_source_check" CHECK ("transaction"."source" in ('connector','import','manual'))
);
--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_group_fk" FOREIGN KEY ("group_id","household_id") REFERENCES "public"."category_group"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_group" ADD CONSTRAINT "category_group_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant" ADD CONSTRAINT "merchant_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant" ADD CONSTRAINT "merchant_default_category_fk" FOREIGN KEY ("default_category_id","household_id") REFERENCES "public"."category"("id","household_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule" ADD CONSTRAINT "rule_category_fk" FOREIGN KEY ("category_id","household_id") REFERENCES "public"."category"("id","household_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_preset" ADD CONSTRAINT "import_preset_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_category_fk" FOREIGN KEY ("category_id","household_id") REFERENCES "public"."category"("id","household_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_merchant_fk" FOREIGN KEY ("merchant_id","household_id") REFERENCES "public"."merchant"("id","household_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_import_batch_fk" FOREIGN KEY ("import_batch_id","household_id") REFERENCES "public"."import_batch"("id","household_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_account_external_id_unique" ON "transaction" USING btree ("account_id","external_id") WHERE "transaction"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_account_dedupe_hash_unique" ON "transaction" USING btree ("account_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX "transaction_household_booking_date_idx" ON "transaction" USING btree ("household_id","booking_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transaction_household_needs_review_idx" ON "transaction" USING btree ("household_id","needs_review") WHERE "transaction"."needs_review";--> statement-breakpoint
CREATE INDEX "transaction_household_category_idx" ON "transaction" USING btree ("household_id","category_id");