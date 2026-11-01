CREATE TABLE "ai_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" text NOT NULL,
	"month" date NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"locale" text NOT NULL,
	"facts" jsonb,
	"content" jsonb,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"regenerations" integer DEFAULT 0 NOT NULL,
	"requested_by" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_report_household_month_unique" UNIQUE("household_id","month"),
	CONSTRAINT "ai_report_status_check" CHECK ("ai_report"."status" in ('pending','ready','failed','skipped')),
	CONSTRAINT "ai_report_month_check" CHECK (extract(day from "ai_report"."month") = 1)
);
--> statement-breakpoint
ALTER TABLE "ai_report" ADD CONSTRAINT "ai_report_household_id_organization_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_report" ADD CONSTRAINT "ai_report_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_report_status_next_attempt_idx" ON "ai_report" USING btree ("status","next_attempt_at");