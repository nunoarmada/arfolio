-- Tenant isolation and updated_at maintenance for the phase 1 tables.
--
-- Same policy as household_settings (see 0001): USING filters SELECT/UPDATE/DELETE targets,
-- WITH CHECK rejects INSERT/UPDATE rows that belong to another household; with
-- app.household_id unset nothing matches (fail closed). FORCE RLS is not used (see 0001).
-- Grants to pfm_app come from ensureAppRole() after migrations.
--
-- set_updated_at() keeps updated_at current on every UPDATE, whatever the writer.
CREATE FUNCTION "set_updated_at"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'financial_account', 'category_group', 'category', 'merchant', 'rule',
    'import_batch', 'import_preset', 'transaction'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "household_isolation" ON %I AS PERMISSIVE FOR ALL '
      'USING ("household_id" = current_setting(''app.household_id'', true)) '
      'WITH CHECK ("household_id" = current_setting(''app.household_id'', true))',
      t
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION "set_updated_at"()',
      t || '_set_updated_at', t
    );
  END LOOP;
END
$$;
