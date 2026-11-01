ALTER TABLE "transaction" ADD COLUMN "transaction_date" date;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "mcc" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "details" jsonb;