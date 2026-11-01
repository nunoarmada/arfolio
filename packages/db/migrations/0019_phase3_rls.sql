-- Tenant isolation and updated_at maintenance for the phase 3 tables (same pattern as 0014).
-- USING filters SELECT/UPDATE/DELETE targets, WITH CHECK rejects rows of another household;
-- with app.household_id unset nothing matches (fail closed). Grants to pfm_app come from
-- ensureAppRole() after migrations. set_updated_at() is defined in 0007.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'budget', 'budget_line', 'budget_line_category', 'budget_amount', 'recurring'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "household_isolation" ON %I AS PERMISSIVE FOR ALL '
      'USING ("household_id" = current_setting(''app.household_id'', true)) '
      'WITH CHECK ("household_id" = current_setting(''app.household_id'', true))',
      t
    );
  END LOOP;

  FOREACH t IN ARRAY ARRAY['budget', 'budget_line', 'recurring']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "set_updated_at"()',
      t || '_set_updated_at', t
    );
  END LOOP;
END
$$;
