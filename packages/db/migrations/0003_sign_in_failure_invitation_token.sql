CREATE TABLE "invitation_token" (
	"invitation_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sign_in_failure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitation_token" ADD CONSTRAINT "invitation_token_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_failure_email_attempted_at_idx" ON "sign_in_failure" USING btree ("email","attempted_at");--> statement-breakpoint
CREATE INDEX "sign_in_failure_attempted_at_idx" ON "sign_in_failure" USING btree ("attempted_at");