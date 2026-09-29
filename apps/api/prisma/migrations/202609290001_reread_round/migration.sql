-- 为同一页的多次重读增加稳定的“页内轮次”序号，按创建先后编号。
ALTER TABLE "reread_marks" ADD COLUMN "round_within_page" INTEGER;

-- 按现有记录的创建时间回填页内轮次（同页同时间用 id 兜底，保证唯一顺序）。
UPDATE "reread_marks" AS target
SET "round_within_page" = subquery."round_within_page"
FROM (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "book_id", "page_number"
            ORDER BY "created_at", "id"
        ) AS "round_within_page"
    FROM "reread_marks"
) AS subquery
WHERE target."id" = subquery."id";

ALTER TABLE "reread_marks" ALTER COLUMN "round_within_page" SET NOT NULL;

CREATE INDEX "reread_marks_book_id_page_number_round_within_page_deleted_at_idx"
    ON "reread_marks"("book_id", "page_number", "round_within_page", "deleted_at");

-- 同一本书同一页，未删除记录的页内轮次必须唯一；并发写以咨询锁串行化，此索引兜底。
CREATE UNIQUE INDEX "reread_marks_book_page_round_active_key"
    ON "reread_marks"("book_id", "page_number", "round_within_page")
    WHERE "deleted_at" IS NULL;
