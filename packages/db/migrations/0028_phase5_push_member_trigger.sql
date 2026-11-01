-- A membership can end through several doors: our removeMember, but also Better Auth's own
-- POST /organization/remove-member and /organization/leave, and cascades from user or organization
-- deletes. All of them delete the `member` row, so the push devices of that user in that household
-- are dropped here, in the same transaction as the delete. The function is SECURITY DEFINER because
-- push_subscription has RLS and these paths run without app.household_id; it only ever deletes the
-- OLD row's own (household, user) pair. search_path is pinned, execution is not granted to PUBLIC
-- (a trigger function cannot be called directly anyway).
CREATE FUNCTION "drop_push_devices_of_member"() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public."push_subscription"
  WHERE "household_id" = OLD."organization_id" AND "user_id" = OLD."user_id";
  RETURN OLD;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "drop_push_devices_of_member"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "member_drop_push_devices" AFTER DELETE ON "member"
  FOR EACH ROW EXECUTE FUNCTION "drop_push_devices_of_member"();
