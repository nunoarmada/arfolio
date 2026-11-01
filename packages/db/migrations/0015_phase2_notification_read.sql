ALTER TABLE "notification" ADD CONSTRAINT "notification_id_household_unique" UNIQUE("id","household_id");--> statement-breakpoint
CREATE TABLE "notification_read" (
	"notification_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"household_id" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_read_pk" PRIMARY KEY("notification_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notification_read" ADD CONSTRAINT "notification_read_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_read" ADD CONSTRAINT "notification_read_notification_fk" FOREIGN KEY ("notification_id","household_id") REFERENCES "public"."notification"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_read_user_idx" ON "notification_read" USING btree ("household_id","user_id");--> statement-breakpoint
ALTER TABLE "notification" DROP COLUMN "read_at";