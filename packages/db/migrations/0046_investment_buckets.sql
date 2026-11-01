CREATE TABLE "investment_bucket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investment_bucket_id_household_unique" UNIQUE("id","household_id"),
	CONSTRAINT "investment_bucket_account_external_unique" UNIQUE("account_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "investment_bucket_snapshot" (
	"bucket_id" uuid NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"invested_minor" bigint NOT NULL,
	"value_minor" bigint,
	"currency" char(3) NOT NULL,
	CONSTRAINT "investment_bucket_snapshot_pk" PRIMARY KEY("bucket_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "budget_line_bucket" (
	"budget_line_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"household_id" text NOT NULL,
	"bucket_id" uuid NOT NULL,
	CONSTRAINT "budget_line_bucket_pk" PRIMARY KEY("budget_line_id","bucket_id"),
	CONSTRAINT "budget_line_bucket_budget_bucket_unique" UNIQUE("budget_id","bucket_id")
);
--> statement-breakpoint
DROP TABLE "budget_line_instrument" CASCADE;--> statement-breakpoint
ALTER TABLE "investment_bucket" ADD CONSTRAINT "investment_bucket_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_bucket" ADD CONSTRAINT "investment_bucket_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_bucket_snapshot" ADD CONSTRAINT "investment_bucket_snapshot_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_bucket_snapshot" ADD CONSTRAINT "investment_bucket_snapshot_bucket_fk" FOREIGN KEY ("bucket_id","household_id") REFERENCES "public"."investment_bucket"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_bucket_snapshot" ADD CONSTRAINT "investment_bucket_snapshot_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line_bucket" ADD CONSTRAINT "budget_line_bucket_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line_bucket" ADD CONSTRAINT "budget_line_bucket_line_fk" FOREIGN KEY ("budget_line_id","budget_id","household_id") REFERENCES "public"."budget_line"("id","budget_id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line_bucket" ADD CONSTRAINT "budget_line_bucket_bucket_fk" FOREIGN KEY ("bucket_id","household_id") REFERENCES "public"."investment_bucket"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investment_bucket_household_idx" ON "investment_bucket" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "investment_bucket_snapshot_account_as_of_idx" ON "investment_bucket_snapshot" USING btree ("account_id","as_of");--> statement-breakpoint
CREATE INDEX "budget_line_bucket_household_idx" ON "budget_line_bucket" USING btree ("household_id");--> statement-breakpoint
-- Tenant isolation (same pattern as 0019). Grants to pfm_app come from ensureAppRole().
ALTER TABLE "investment_bucket" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "investment_bucket" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
ALTER TABLE "investment_bucket_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "investment_bucket_snapshot" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
ALTER TABLE "budget_line_bucket" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "budget_line_bucket" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
CREATE TRIGGER "investment_bucket_set_updated_at" BEFORE UPDATE ON "investment_bucket" FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
