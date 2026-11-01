ALTER TABLE "asset_valuation" DROP CONSTRAINT "asset_valuation_method_check";--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "ai_valuation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "ai_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "ai_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "ai_last_error" text;--> statement-breakpoint
ALTER TABLE "asset_valuation" ADD COLUMN "estimate" jsonb;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_ai_depreciation_check" CHECK (not ("asset"."ai_valuation" and "asset"."depreciation_bps_per_year" is not null));--> statement-breakpoint
ALTER TABLE "asset_valuation" ADD CONSTRAINT "asset_valuation_method_check" CHECK ("asset_valuation"."method" in ('manual','connector','depreciation','import','ai'));
