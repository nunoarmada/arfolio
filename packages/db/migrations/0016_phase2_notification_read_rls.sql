-- Tenant isolation for notification_read (same pattern as 0014): USING filters
-- SELECT/UPDATE/DELETE targets, WITH CHECK rejects rows of another household; with
-- app.household_id unset nothing matches (fail closed). Grants to pfm_app come from
-- ensureAppRole() after migrations.
ALTER TABLE "notification_read" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "household_isolation" ON "notification_read" AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));
