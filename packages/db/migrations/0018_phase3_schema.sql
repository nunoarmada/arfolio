CREATE TABLE "budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"start_month" date NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "budget_household_start_month_unique" UNIQUE("household_id","start_month"),
	CONSTRAINT "budget_status_check" CHECK ("budget"."status" in ('active','archived')),
	CONSTRAINT "budget_start_month_check" CHECK (extract(day from "budget"."start_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "budget_amount" (
	"budget_line_id" uuid NOT NULL,
	"household_id" text NOT NULL,
	"month_index" smallint NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "budget_amount_pk" PRIMARY KEY("budget_line_id","month_index"),
	CONSTRAINT "budget_amount_month_index_check" CHECK ("budget_amount"."month_index" between 1 and 12),
	CONSTRAINT "budget_amount_amount_check" CHECK ("budget_amount"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"budget_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"group_id" uuid,
	"account_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_line_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "budget_line_id_budget_household_unique" UNIQUE("id","budget_id","household_id"),
	CONSTRAINT "budget_line_budget_kind_name_unique" UNIQUE("budget_id","kind","name"),
	CONSTRAINT "budget_line_kind_check" CHECK ("budget_line"."kind" in ('income','expense','saving'))
);
--> statement-breakpoint
CREATE TABLE "budget_line_category" (
	"budget_line_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"household_id" text NOT NULL,
	CONSTRAINT "budget_line_category_pk" PRIMARY KEY("budget_line_id","category_id"),
	CONSTRAINT "budget_line_category_budget_category_unique" UNIQUE("budget_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "recurring" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid,
	"merchant_key" text NOT NULL,
	"name" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"cadence" text NOT NULL,
	"next_expected_on" date,
	"last_seen_on" date,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"category_id" uuid,
	"budget_line_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_cadence_check" CHECK ("recurring"."cadence" in ('weekly','monthly','quarterly','yearly')),
	CONSTRAINT "recurring_status_check" CHECK ("recurring"."status" in ('detected','confirmed','dismissed')),
	CONSTRAINT "recurring_source_check" CHECK ("recurring"."source" in ('detected','declared','import'))
);
--> statement-breakpoint
ALTER TABLE "household_settings" ADD COLUMN "hub_account_id" uuid;--> statement-breakpoint
ALTER TABLE "household_settings" ADD COLUMN "budget_alert_thresholds" smallint[] DEFAULT '{80,100}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_amount" ADD CONSTRAINT "budget_amount_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_amount" ADD CONSTRAINT "budget_amount_line_fk" FOREIGN KEY ("budget_line_id","household_id") REFERENCES "public"."budget_line"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_budget_fk" FOREIGN KEY ("budget_id","household_id") REFERENCES "public"."budget"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_group_fk" FOREIGN KEY ("group_id","household_id") REFERENCES "public"."category_group"("id","household_id") ON DELETE set null ("group_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE set null ("account_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line_category" ADD CONSTRAINT "budget_line_category_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line_category" ADD CONSTRAINT "budget_line_category_line_fk" FOREIGN KEY ("budget_line_id","budget_id","household_id") REFERENCES "public"."budget_line"("id","budget_id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line_category" ADD CONSTRAINT "budget_line_category_category_fk" FOREIGN KEY ("category_id","household_id") REFERENCES "public"."category"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE set null ("account_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_category_fk" FOREIGN KEY ("category_id","household_id") REFERENCES "public"."category"("id","household_id") ON DELETE set null ("category_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring" ADD CONSTRAINT "recurring_budget_line_fk" FOREIGN KEY ("budget_line_id","household_id") REFERENCES "public"."budget_line"("id","household_id") ON DELETE set null ("budget_line_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_amount_household_idx" ON "budget_amount" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "budget_line_household_budget_idx" ON "budget_line" USING btree ("household_id","budget_id");--> statement-breakpoint
CREATE INDEX "budget_line_category_household_idx" ON "budget_line_category" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_detected_merchant_cadence_unique" ON "recurring" USING btree ("household_id","merchant_key","cadence") WHERE "recurring"."source" = 'detected';--> statement-breakpoint
CREATE INDEX "recurring_household_status_idx" ON "recurring" USING btree ("household_id","status");--> statement-breakpoint
ALTER TABLE "household_settings" ADD CONSTRAINT "household_settings_hub_account_fk" FOREIGN KEY ("hub_account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE set null ("hub_account_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_settings" ADD CONSTRAINT "household_settings_budget_alert_thresholds_check" CHECK (1 <= all("household_settings"."budget_alert_thresholds") and 200 >= all("household_settings"."budget_alert_thresholds") and array_position("household_settings"."budget_alert_thresholds", null) is null);