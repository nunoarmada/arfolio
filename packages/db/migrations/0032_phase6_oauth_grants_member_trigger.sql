-- Removing a member (remove, leave, user or organization delete cascades) also ends the user's
-- OAuth grants. oauth_* tables are not household-scoped, so a grant would otherwise survive
-- removal and revive when the user is re-invited. SECURITY DEFINER because these paths run
-- without app.household_id; it only deletes rows of OLD."user_id". search_path pinned, no PUBLIC
-- execute. Access tokens first (they reference refresh tokens).
CREATE FUNCTION "drop_oauth_grants_of_member"() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public."oauth_access_token" WHERE "user_id" = OLD."user_id";
  DELETE FROM public."oauth_refresh_token" WHERE "user_id" = OLD."user_id";
  DELETE FROM public."oauth_consent" WHERE "user_id" = OLD."user_id";
  RETURN OLD;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "drop_oauth_grants_of_member"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "member_drop_oauth_grants" AFTER DELETE ON "member"
  FOR EACH ROW EXECUTE FUNCTION "drop_oauth_grants_of_member"();
