CREATE TABLE "merchant_logo" (
	"merchant_id" uuid PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"content_type" text,
	"bytes" "bytea",
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "merchant_logo_status_check" CHECK ("merchant_logo"."status" in ('ok','missing'))
);
--> statement-breakpoint
ALTER TABLE "merchant" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "merchant" ADD COLUMN "enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchant" ADD COLUMN "name_source" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "merchant_enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "merchant_enrich_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_logo" ADD CONSTRAINT "merchant_logo_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_logo" ADD CONSTRAINT "merchant_logo_merchant_fk" FOREIGN KEY ("merchant_id","household_id") REFERENCES "public"."merchant"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_logo_household_idx" ON "merchant_logo" USING btree ("household_id");--> statement-breakpoint
ALTER TABLE "merchant" ADD CONSTRAINT "merchant_name_source_check" CHECK ("merchant"."name_source" in ('ai','user'));--> statement-breakpoint
-- Tenant isolation for merchant_logo (same pattern as 0034). The grants of pfm_app come from
-- ensureAppRole() (blanket table grants plus default privileges), so none are needed here.
ALTER TABLE "merchant_logo" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "merchant_logo" AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));
