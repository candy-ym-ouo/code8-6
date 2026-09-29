-- 同页多次重读按时间先后分配稳定的“重读轮次”（含已软删除记录，轮次永不复用）。
ALTER TABLE "reread_marks" ADD COLUMN "reread_round" INTEGER;

UPDATE "reread_marks" AS target
SET "reread_round" = backfill.round
FROM (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "book_id", "page_number"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS round
  FROM "reread_marks"
) AS backfill
WHERE target."id" = backfill."id";

ALTER TABLE "reread_marks" ALTER COLUMN "reread_round" SET NOT NULL;
ALTER TABLE "reread_marks" ALTER COLUMN "reread_round" SET DEFAULT 1;

CREATE INDEX "reread_marks_book_page_round_deleted_at_idx"
  ON "reread_marks"("book_id", "page_number", "reread_round", "deleted_at");
