CREATE TABLE "investment_bucket_holding" (
	"bucket_id" uuid NOT NULL,
	"household_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"ticker" text NOT NULL,
	"quantity" numeric(28, 10) NOT NULL,
	"invested_minor" bigint NOT NULL,
	"value_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "investment_bucket_holding_pk" PRIMARY KEY("bucket_id","as_of","ticker")
);
--> statement-breakpoint
ALTER TABLE "investment_bucket_holding" ADD CONSTRAINT "investment_bucket_holding_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_bucket_holding" ADD CONSTRAINT "investment_bucket_holding_bucket_fk" FOREIGN KEY ("bucket_id","household_id") REFERENCES "public"."investment_bucket"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_bucket_holding" ADD CONSTRAINT "investment_bucket_holding_account_fk" FOREIGN KEY ("account_id","household_id") REFERENCES "public"."financial_account"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investment_bucket_holding_account_as_of_idx" ON "investment_bucket_holding" USING btree ("account_id","as_of");--> statement-breakpoint
-- Tenant isolation (same pattern as 0019). Grants to pfm_app come from ensureAppRole().
ALTER TABLE "investment_bucket_holding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "investment_bucket_holding" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));
