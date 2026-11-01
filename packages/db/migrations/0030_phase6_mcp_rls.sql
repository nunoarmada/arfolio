-- Tenant isolation for audit_log and personal_access_token (same pattern as 0021 / 0026).
-- audit_log is append-only for pfm_app: ensureAppRole() revokes update and delete on it after its
-- blanket table grants (no household policy can express "insert but never change").
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "audit_log" AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
ALTER TABLE "personal_access_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "personal_access_token" AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
-- A bearer request has no household yet: the token is what identifies it, so RLS would hide the
-- row it is looking for. pat_lookup is the only path across that boundary. It returns at most the
-- one row whose sha256 equals the argument (the hash of a 256-bit random token is unguessable) and
-- only the columns verifyPat needs; revoked and expired rows are returned too, the service rejects
-- them, so the function stays a pure lookup. The caller's role is NOT looked up here: verifyPat
-- reads it from `member` inside withHousehold for the household found, which also scopes its
-- last_used_at update by RLS. Owner-only execution is granted to pfm_app by ensureAppRole();
-- search_path is pinned against hijacking.
CREATE FUNCTION "pat_lookup"(p_hash bytea)
  RETURNS TABLE("id" uuid, "household_id" text, "user_id" text, "scope" text,
                "expires_at" timestamp with time zone, "revoked_at" timestamp with time zone)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t."id", t."household_id", t."user_id", t."scope", t."expires_at", t."revoked_at"
  FROM public."personal_access_token" t
  WHERE t."token_hash" = p_hash
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "pat_lookup"(bytea) FROM PUBLIC;--> statement-breakpoint
-- `member` has no (organization_id, user_id) key a composite FK could reference, so, as for push
-- devices (0028), a membership ending by ANY door (our removeMember, Better Auth's remove-member
-- and leave, user or organization delete cascades) drops the user's PATs of that household in the
-- same transaction. SECURITY DEFINER because these paths run without app.household_id; it only
-- deletes the OLD row's own (household, user) pair. search_path pinned, no PUBLIC execute.
CREATE FUNCTION "drop_pats_of_member"() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public."personal_access_token"
  WHERE "household_id" = OLD."organization_id" AND "user_id" = OLD."user_id";
  RETURN OLD;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "drop_pats_of_member"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "member_drop_pats" AFTER DELETE ON "member"
  FOR EACH ROW EXECUTE FUNCTION "drop_pats_of_member"();
