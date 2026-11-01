-- Tenant isolation for undo_token: same policy as the other household tables (see 0007).
ALTER TABLE "undo_token" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "household_isolation" ON "undo_token" AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));
