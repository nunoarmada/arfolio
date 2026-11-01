ALTER TABLE "sync_run" DROP CONSTRAINT "sync_run_status_check";--> statement-breakpoint
ALTER TABLE "sync_run" ADD COLUMN "skipped_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "transaction_household_ai_suggested_category_idx" ON "transaction" USING btree ("household_id","ai_suggested_category_id");--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_status_check" CHECK ("sync_run"."status" in ('running','success','partial','failed','skipped'));