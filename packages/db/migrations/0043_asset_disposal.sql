ALTER TABLE "asset" ADD COLUMN "disposed_on" date;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "disposal_kind" text;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "sale_amount" bigint;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "sale_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "liability" ADD COLUMN "settled_on" date;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_id_household_unique" UNIQUE("id","household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_sale_transaction_unique" ON "asset" USING btree ("sale_transaction_id") WHERE "asset"."sale_transaction_id" is not null;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_sale_transaction_fk" FOREIGN KEY ("sale_transaction_id","household_id") REFERENCES "public"."transaction"("id","household_id") ON DELETE set null ("sale_transaction_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_disposal_check" CHECK (("asset"."disposed_on" is null) = ("asset"."disposal_kind" is null));--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_disposal_kind_check" CHECK ("asset"."disposal_kind" in ('sold','written_off'));--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_sale_check" CHECK (coalesce("asset"."disposal_kind", '') = 'sold' or ("asset"."sale_amount" is null and "asset"."sale_transaction_id" is null));--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_sale_amount_check" CHECK ("asset"."sale_amount" is null or "asset"."sale_amount" >= 0);