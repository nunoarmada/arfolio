-- Tenant isolation for push_subscription (same pattern as 0021). instance_secret is deliberately
-- NOT covered: it is a global table with no household, reached by pfm_app through the blanket
-- grants from ensureAppRole (like sign_in_failure); its secret values are encrypted at rest.
ALTER TABLE "push_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "push_subscription" AS PERMISSIVE FOR ALL
  USING ("household_id" = current_setting('app.household_id', true))
  WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
-- A push endpoint identifies one browser profile and is unique across ALL households, so a device
-- that moves to another household (another user signs in on it) must first be released by its
-- previous household, which RLS hides from the caller. This is the only path across that boundary:
-- it deletes subscriptions of the given endpoint in households OTHER than the caller's
-- (app.household_id, set by withHousehold), and does nothing when no household is set. Knowing an
-- endpoint (an unguessable URL) already implies controlling that browser. Owner-only execution is
-- granted to pfm_app by ensureAppRole(); search_path is pinned against hijacking.
CREATE FUNCTION "claim_push_endpoint"(p_endpoint text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM public."push_subscription"
  WHERE "endpoint" = p_endpoint
    AND coalesce(current_setting('app.household_id', true), '') <> ''
    AND "household_id" <> current_setting('app.household_id', true)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "claim_push_endpoint"(text) FROM PUBLIC;
