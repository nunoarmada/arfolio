CREATE TABLE "household_settings" (
	"household_id" text PRIMARY KEY NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"locale" text DEFAULT 'pt-PT' NOT NULL,
	"timezone" text DEFAULT 'Europe/Lisbon' NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"emergency_fund_months" smallint DEFAULT 6 NOT NULL,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_settings_fiscal_year_start_month_check" CHECK ("household_settings"."fiscal_year_start_month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "system_status" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
