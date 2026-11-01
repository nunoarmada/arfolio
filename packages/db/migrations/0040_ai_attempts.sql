ALTER TABLE "transaction" ADD COLUMN "ai_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- BACKFILL
-- Rows judged under the old "suggest only" behaviour. Rows a person edited,
-- categorised or linked as a transfer are never touched.
-- A stored suggestion whose category still fits the amount sign becomes the applied category,
-- left in review for the person to confirm.
UPDATE "transaction" AS t
SET "category_id" = t."ai_suggested_category_id",
    "categorised_by" = 'ai',
    "confidence" = t."ai_confidence",
    "needs_review" = true,
    "ai_attempts" = 1,
    "updated_at" = now()
FROM "category" AS c
JOIN "category_group" AS g ON g."id" = c."group_id" AND g."household_id" = c."household_id"
WHERE c."id" = t."ai_suggested_category_id"
  AND c."household_id" = t."household_id"
  AND c."archived_at" IS NULL
  AND g."archived_at" IS NULL
  AND g."kind" <> 'transfer'
  AND (g."kind" = 'saving' OR t."amount" = 0 OR (t."amount" < 0 AND g."kind" = 'expense') OR (t."amount" > 0 AND g."kind" = 'income'))
  AND t."category_id" IS NULL
  AND t."user_edited_at" IS NULL
  AND t."transfer_group_id" IS NULL;--> statement-breakpoint
-- Any other row the model already judged counts as one attempt and is retried (twice more).
UPDATE "transaction"
SET "ai_attempts" = 1,
    "ai_confidence" = NULL,
    "ai_suggested_category_id" = NULL,
    "updated_at" = now()
WHERE "category_id" IS NULL
  AND "user_edited_at" IS NULL
  AND "transfer_group_id" IS NULL
  AND "ai_attempts" = 0
  AND ("ai_confidence" IS NOT NULL OR "ai_suggested_category_id" IS NOT NULL);
