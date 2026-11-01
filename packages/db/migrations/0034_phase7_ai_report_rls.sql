-- Tenant isolation for ai_report (same pattern as 0021 / 0026 / 0030). The grants of pfm_app come
-- from ensureAppRole() (blanket table grants plus default privileges), so none are needed here.
ALTER TABLE "ai_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "ai_report" AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));
