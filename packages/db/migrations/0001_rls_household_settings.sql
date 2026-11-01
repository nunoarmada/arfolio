-- Tenant isolation for household_settings.
--
-- Policy: a row is visible/writable only when its household_id equals the transaction-local
-- setting `app.household_id`, which withHousehold() sets via set_config(..., true).
--   * USING       filters SELECT/UPDATE/DELETE targets.
--   * WITH CHECK  rejects INSERT/UPDATE rows that belong to another household.
-- With the setting unset, current_setting(..., true) returns NULL (or '' after a reset), so no
-- row matches and queries outside withHousehold() see nothing: fail closed.
--
-- FORCE ROW LEVEL SECURITY is deliberately not used. The app and worker connect as `pfm_app`,
-- which does not own the table, so RLS already applies to them. Only the owner role (used by
-- migrations) bypasses it, which migrations need. FORCE would add nothing for pfm_app and
-- would get in the way of owner-run maintenance.
--
-- Grants to pfm_app are applied by ensureAppRole() after migrations (the role is created there,
-- with a rotating password), not here.
ALTER TABLE "household_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "household_isolation" ON "household_settings"
  AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));
