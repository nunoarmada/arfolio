ALTER TABLE "goal" ADD COLUMN "saved_baseline" bigint;--> statement-breakpoint
ALTER TABLE "goal" ADD COLUMN "saved_baseline_date" date;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_saved_baseline_check" CHECK ("goal"."saved_baseline" is null or "goal"."saved_baseline" >= 0);--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_saved_baseline_date_check" CHECK (("goal"."saved_baseline" is null) = ("goal"."saved_baseline_date" is null));