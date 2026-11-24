-- Saved settings live in instance_secret and are cached per process (web replicas, worker). Any
-- change to the table, from the app or from plain SQL, sends one NOTIFY on the 'arfolio_settings'
-- channel so every process can drop its cache. The notification is delivered at commit, so a
-- listener never sees a change that was rolled back. The function is a plain (SECURITY INVOKER)
-- trigger function: pg_notify is executable by everyone, so pfm_app can write the table and fire
-- the trigger without extra grants. Rows that are not settings (e.g. 'vapid') also notify; the
-- only effect is one extra cache drop.
CREATE FUNCTION "notify_settings_changed"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_catalog.pg_notify('arfolio_settings', '');
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "instance_secret_notify_settings_changed"
  AFTER INSERT OR UPDATE OR DELETE ON "instance_secret"
  FOR EACH STATEMENT EXECUTE FUNCTION "notify_settings_changed"();
