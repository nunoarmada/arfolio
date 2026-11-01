CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"account_id" uuid,
	"currency" char(3) NOT NULL,
	"depreciation_bps_per_year" integer,
	"archived" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "asset_kind_check" CHECK ("asset"."kind" in ('real_estate','vehicle','investment','cash','other')),
	CONSTRAINT "asset_depreciation_check" CHECK ("asset"."depreciation_bps_per_year" is null or "asset"."depreciation_bps_per_year" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "asset_valuation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"value" bigint NOT NULL,
	"method" text NOT NULL,
	"note" text,
	CONSTRAINT "asset_valuation_asset_as_of_unique" UNIQUE("asset_id","as_of"),
	CONSTRAINT "asset_valuation_value_check" CHECK ("asset_valuation"."value" >= 0),
	CONSTRAINT "asset_valuation_method_check" CHECK ("asset_valuation"."method" in ('manual','connector','depreciation','import'))
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"target_amount" bigint,
	"target_date" date,
	"account_id" uuid,
	"budget_line_id" uuid,
	"monthly_contribution" bigint,
	"archived" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_kind_check" CHECK ("goal"."kind" in ('generic','emergency_fund')),
	CONSTRAINT "goal_target_amount_check" CHECK ("goal"."target_amount" is null or "goal"."target_amount" >= 0),
	CONSTRAINT "goal_monthly_contribution_check" CHECK ("goal"."monthly_contribution" is null or "goal"."monthly_contribution" >= 0)
);
--> statement-breakpoint
CREATE TABLE "liability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"account_id" uuid,
	"asset_id" uuid,
	"currency" char(3) NOT NULL,
	"principal" bigint,
	"annual_rate_bps" integer,
	"term_months" integer,
	"start_date" date,
	"archived" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liability_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "liability_kind_check" CHECK ("liability"."kind" in ('mortgage','loan','debt','card','other')),
	CONSTRAINT "liability_annual_rate_check" CHECK ("liability"."annual_rate_bps" is null or "liability"."annual_rate_bps" between 0 and 100000),
	CONSTRAINT "liability_term_months_check" CHECK ("liability"."term_months" is null or "liability"."term_months" between 1 and 600)
);
--> statement-breakpoint
CREATE TABLE "liability_balance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"liability_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"balance" bigint NOT NULL,
	"source" text NOT NULL,
	"note" text,
	CONSTRAINT "liability_balance_liability_as_of_unique" UNIQUE("liability_id","as_of"),
	CONSTRAINT "liability_balance_balance_check" CHECK ("liability_balance"."balance" >= 0),
	CONSTRAINT "liability_balance_source_check" CHECK ("liability_balance"."source" in ('manual','connector','schedule','import'))
);
--> statement-breakpoint
CREATE TABLE "net_worth_snapshot" (
	"household_id" text NOT NULL,
	"month" date NOT NULL,
	"assets" bigint NOT NULL,
	"liabilities" bigint NOT NULL,
	"net" bigint NOT NULL,
	"breakdown" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "net_worth_snapshot_pk" PRIMARY KEY("household_id","month"),
	CONSTRAINT "net_worth_snapshot_month_check" CHECK (extract(day from "net_worth_snapshot"."month") = 1)
);
--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE set null ("account_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_asset_fk" FOREIGN KEY ("asset_id","household_id") REFERENCES "public"."asset"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE set null ("account_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_budget_line_fk" FOREIGN KEY ("budget_line_id","household_id") REFERENCES "public"."budget_line"("id","household_id") ON DELETE set null ("budget_line_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE set null ("account_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_asset_fk" FOREIGN KEY ("asset_id","household_id") REFERENCES "public"."asset"("id","household_id") ON DELETE set null ("asset_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability_balance" ADD CONSTRAINT "liability_balance_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability_balance" ADD CONSTRAINT "liability_balance_liability_fk" FOREIGN KEY ("liability_id","household_id") REFERENCES "public"."liability"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "net_worth_snapshot" ADD CONSTRAINT "net_worth_snapshot_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_household_idx" ON "asset" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "asset_valuation_household_asset_as_of_idx" ON "asset_valuation" USING btree ("household_id","asset_id","as_of" desc);--> statement-breakpoint
CREATE INDEX "goal_household_idx" ON "goal" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "liability_household_idx" ON "liability" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "liability_balance_household_liability_as_of_idx" ON "liability_balance" USING btree ("household_id","liability_id","as_of" desc);