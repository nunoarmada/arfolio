ALTER TABLE "instance_secret" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_secret" ADD COLUMN "updated_by" text;