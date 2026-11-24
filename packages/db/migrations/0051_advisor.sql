CREATE TABLE "advisor_member_settings" (
	"household_id" text NOT NULL,
	"user_id" text NOT NULL,
	"proactive_enabled" boolean DEFAULT true NOT NULL,
	"weekly_cap" integer,
	"opened_at" timestamp with time zone,
	CONSTRAINT "advisor_member_settings_pk" PRIMARY KEY("household_id","user_id"),
	CONSTRAINT "advisor_member_settings_weekly_cap_check" CHECK ("advisor_member_settings"."weekly_cap" between 0 and 14)
);
--> statement-breakpoint
CREATE TABLE "advisor_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"origin" text NOT NULL,
	"text" text NOT NULL,
	"event_key" text,
	"counts_toward_cap" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisor_message_role_check" CHECK ("advisor_message"."role" in ('user','assistant')),
	CONSTRAINT "advisor_message_origin_check" CHECK ("advisor_message"."origin" in ('chat','proactive')),
	CONSTRAINT "advisor_message_status_check" CHECK ("advisor_message"."status" in ('pending','complete','failed'))
);
--> statement-breakpoint
CREATE TABLE "advisor_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisor_note_text_check" CHECK (char_length("advisor_note"."text") <= 500)
);
--> statement-breakpoint
CREATE TABLE "advisor_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"user_id" text NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"basis" jsonb,
	"target_updated_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "advisor_proposal_kind_check" CHECK ("advisor_proposal"."kind" in ('goal_create','goal_update','budget_line_amount','rule_create','transaction_categorise')),
	CONSTRAINT "advisor_proposal_status_check" CHECK ("advisor_proposal"."status" in ('pending','applied','dismissed','stale'))
);
--> statement-breakpoint
ALTER TABLE "advisor_member_settings" ADD CONSTRAINT "advisor_member_settings_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_member_settings" ADD CONSTRAINT "advisor_member_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_message" ADD CONSTRAINT "advisor_message_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_message" ADD CONSTRAINT "advisor_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_note" ADD CONSTRAINT "advisor_note_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_note" ADD CONSTRAINT "advisor_note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_proposal" ADD CONSTRAINT "advisor_proposal_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_proposal" ADD CONSTRAINT "advisor_proposal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_proposal" ADD CONSTRAINT "advisor_proposal_message_id_advisor_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."advisor_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advisor_message_member_created_idx" ON "advisor_message" USING btree ("household_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_message_event_key_unique" ON "advisor_message" USING btree ("household_id","user_id","event_key") WHERE "advisor_message"."event_key" is not null;--> statement-breakpoint
CREATE INDEX "advisor_note_member_idx" ON "advisor_note" USING btree ("household_id","user_id");--> statement-breakpoint
CREATE INDEX "advisor_proposal_message_idx" ON "advisor_proposal" USING btree ("message_id");--> statement-breakpoint
-- Tenant isolation (same pattern as 0019). Grants to pfm_app come from ensureAppRole().
ALTER TABLE "advisor_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "advisor_message" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
ALTER TABLE "advisor_proposal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "advisor_proposal" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
ALTER TABLE "advisor_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "advisor_note" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));--> statement-breakpoint
ALTER TABLE "advisor_member_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "advisor_member_settings" AS PERMISSIVE FOR ALL USING ("household_id" = current_setting('app.household_id', true)) WITH CHECK ("household_id" = current_setting('app.household_id', true));
--> statement-breakpoint
-- Advisor conversations are private to a member of one household and end with the membership, through
-- any door (our removeMember, Better Auth's remove-member / leave, cascades). Same pattern as 0028:
-- SECURITY DEFINER because these tables have RLS and those paths run without app.household_id; it
-- only deletes the OLD row's own (household, user) pair.
CREATE FUNCTION "drop_advisor_data_of_member"() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public."advisor_proposal" WHERE "household_id" = OLD."organization_id" AND "user_id" = OLD."user_id";
  DELETE FROM public."advisor_message" WHERE "household_id" = OLD."organization_id" AND "user_id" = OLD."user_id";
  DELETE FROM public."advisor_note" WHERE "household_id" = OLD."organization_id" AND "user_id" = OLD."user_id";
  DELETE FROM public."advisor_member_settings" WHERE "household_id" = OLD."organization_id" AND "user_id" = OLD."user_id";
  RETURN OLD;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "drop_advisor_data_of_member"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "member_drop_advisor_data" AFTER DELETE ON "member"
  FOR EACH ROW EXECUTE FUNCTION "drop_advisor_data_of_member"();
