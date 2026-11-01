ALTER TABLE "position_snapshot" ADD COLUMN "cost_minor" bigint;--> statement-breakpoint
ALTER TABLE "position_snapshot" ADD COLUMN "unrealized_pl_minor" bigint;--> statement-breakpoint
ALTER TABLE "position_snapshot" ADD COLUMN "ticker" text;--> statement-breakpoint
ALTER TABLE "position_snapshot" ADD COLUMN "isin" text;