CREATE TABLE "budget_line_instrument" (
	"budget_line_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"household_id" text NOT NULL,
	"instrument" text NOT NULL,
	CONSTRAINT "budget_line_instrument_pk" PRIMARY KEY("budget_line_id","instrument"),
	CONSTRAINT "budget_line_instrument_budget_instrument_unique" UNIQUE("budget_id","instrument"),
	CONSTRAINT "budget_line_instrument_instrument_check" CHECK (char_length("budget_line_instrument"."instrument") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "budget_line_instrument" ADD CONSTRAINT "budget_line_instrument_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_line_instrument" ADD CONSTRAINT "budget_line_instrument_line_fk" FOREIGN KEY ("budget_line_id","budget_id","household_id") REFERENCES "public"."budget_line"("id","budget_id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_line_instrument_household_idx" ON "budget_line_instrument" USING btree ("household_id");--> statement-breakpoint
-- Tenant isolation (same pattern as 0019). Grants to pfm_app come from ensureAppRole().
ALTER TABLE "budget_line_instrument" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "budget_line_instrument" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));
