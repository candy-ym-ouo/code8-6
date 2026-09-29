import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { isRestoreWindowOpen, normalizeText, validatePageRange, validateSinglePage } from '../../lib/domain.js';
import { writeEvent } from '../../lib/events.js';
import { optionalDate, parseId } from '../../lib/http.js';
import { decodeTraceCursor, encodeTraceCursor, type TraceCursor } from '../../lib/cursor.js';

const optionalReason = (max: number) =>
  z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().max(max).nullable().optional()
  );

const dogEarCreateSchema = z.object({
  pageNumber: z.number().int().positive(),
  reason: optionalReason(500)
});

const dogEarUpdateSchema = z
  .object({
    pageNumber: z.number().int().positive().optional(),
    reason: optionalReason(500),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.pageNumber !== undefined || value.reason !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const annotationCreateSchema = z.object({
  startPage: z.number().int().positive(),
  endPage: z.number().int().positive(),
  content: z.string().trim().min(1, '请输入批注').max(5000)
});

const annotationUpdateSchema = z
  .object({
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
    content: z.string().trim().min(1).max(5000).optional(),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.startPage !== undefined || value.endPage !== undefined || value.content !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const rereadCreateSchema = z.object({
  pageNumber: z.number().int().positive(),
  reason: optionalReason(1000)
});

const rereadUpdateSchema = z
  .object({
    pageNumber: z.number().int().positive().optional(),
    reason: optionalReason(1000),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.pageNumber !== undefined || value.reason !== undefined, {
    message: '至少提供一个要更新的字段'
  });

const deleteSchema = z.object({ version: z.number().int().positive().optional() }).optional();

function serializeDogEar(item: {
  id: string;
  bookId: string;
  version: number;
  pageNumber: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'DOG_EAR' as const };
}

function serializeAnnotation(item: {
  id: string;
  bookId: string;
  version: number;
  startPage: number;
  endPage: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'ANNOTATION' as const };
}

function serializeRereadMark(item: {
  id: string;
  bookId: string;
  version: number;
  pageNumber: number;
  rereadRound: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'REREAD_MARK' as const };
}

function assertVersion(current: number, requested?: number): void {
  if (requested && requested !== current) {
    throw new AppError(409, 'STALE_WRITE', '记录已在其他位置被修改，请刷新后重试');
  }
}

function eventSummary(value: string | null | undefined): string {
  return (value ? normalizeText(value).slice(0, 120) : '');
}

export const traceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/books/:bookId/traces', async (request) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');

    const query = request.query as Record<string, unknown>;
    const type = typeof query.type === 'string' && query.type !== 'ALL' ? query.type : undefined;
    if (type && !TRACE_TYPES.includes(type as TraceType)) {
      throw new AppError(422, 'VALIDATION_ERROR', '痕迹类型无效');
    }
    const pageNumber = query.pageNumber === undefined ? undefined : Number(query.pageNumber);
    if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1)) {
      throw new AppError(422, 'VALIDATION_ERROR', '页码无效');
    }
    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
    const rereadOnly = String(query.rereadOnly ?? '').toLowerCase();
    if (rereadOnly && rereadOnly !== 'true' && rereadOnly !== 'false') {
      throw new AppError(422, 'VALIDATION_ERROR', '重读筛选参数无效');
    }
    const hasReason = rereadOnly === 'true';
    const rereadRound = query.rereadRound === undefined ? undefined : Number(query.rereadRound);
    if (rereadRound !== undefined && (!Number.isInteger(rereadRound) || rereadRound < 1)) {
      throw new AppError(422, 'VALIDATION_ERROR', '重读轮次无效');
    }
    if ((hasReason || rereadRound !== undefined) && type && type !== 'REREAD_MARK') {
      throw new AppError(422, 'VALIDATION_ERROR', '重读筛选只能用于重读页');
    }
    const from = optionalDate(query.from, 'from');
    const to = optionalDate(query.to, 'to');
    const dateFilter = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {})
    };
    const rawPageSize = Number(query.pageSize ?? 50);
    const pageSize = Number.isInteger(rawPageSize) && rawPageSize > 0 ? Math.min(rawPageSize, 100) : 50;
    const cursor = decodeTraceCursor(query.cursor);
    const cursorFilter = cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAtValue) } },
            { createdAt: new Date(cursor.createdAtValue), id: { lt: cursor.id } }
          ]
        }
      : {};
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'asc' as const }];

    // 取 pageSize + 1 用于判断是否还有后续；三个表的排序键一致，归并后再截断，
    // 保证跨表游标分页不漏项、不重项。
    const [dogEars, annotations, rereadMarks] = await Promise.all([
      !type || type === 'DOG_EAR'
        ? prisma.dogEar.findMany({
            where: {
              userId,
              bookId,
              deletedAt: null,
              ...(pageNumber ? { pageNumber } : {}),
              ...(keyword ? { reason: { contains: keyword, mode: 'insensitive' } } : {}),
              ...(from || to ? { createdAt: dateFilter } : {}),
              ...cursorFilter
            },
            orderBy,
            take: pageSize + 1
          })
        : [],
      !type || type === 'ANNOTATION'
        ? prisma.annotation.findMany({
            where: {
              userId,
              bookId,
              deletedAt: null,
              ...(pageNumber ? { startPage: { lte: pageNumber }, endPage: { gte: pageNumber } } : {}),
              ...(keyword ? { content: { contains: keyword, mode: 'insensitive' } } : {}),
              ...(from || to ? { createdAt: dateFilter } : {}),
              ...cursorFilter
            },
            orderBy,
            take: pageSize + 1
          })
        : [],
      !type || type === 'REREAD_MARK'
        ? prisma.rereadMark.findMany({
            where: {
              userId,
              bookId,
              deletedAt: null,
              ...(pageNumber ? { pageNumber } : {}),
              ...(rereadRound !== undefined ? { rereadRound } : {}),
              ...(keyword || rereadOnly
                ? {
                    reason: {
                      ...(keyword ? { contains: keyword, mode: 'insensitive' as const } : {}),
                      ...(rereadOnly === 'true' ? { not: null } : {}),
                      ...(rereadOnly === 'false' ? { equals: null } : {})
                    }
                  }
                : {}),
              ...(from || to ? { createdAt: dateFilter } : {}),
              ...cursorFilter
            },
            orderBy,
            take: pageSize + 1
          })
        : []
    ]);

    const merged = [
      ...dogEars.map(serializeDogEar),
      ...annotations.map(serializeAnnotation),
      ...rereadMarks.map(serializeRereadMark)
    ].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const items = merged.slice(0, pageSize);
    const hasMore = merged.length > pageSize;
    const last = items[items.length - 1];
    const nextCursor: string | undefined = hasMore && last
      ? encodeTraceCursor({ createdAtValue: last.createdAt.getTime(), id: last.id } satisfies TraceCursor)
      : undefined;
    return { items, page: { pageSize, hasMore, nextCursor } };
  });

  app.post('/books/:bookId/dog-ears', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = dogEarCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '折角信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validateSinglePage(parsed.data.pageNumber, book.pageCount);
    const reason = parsed.data.reason ? normalizeText(parsed.data.reason) : null;
    const existing = await prisma.dogEar.findFirst({
      where: { bookId, pageNumber: parsed.data.pageNumber, deletedAt: null }
    });
    if (existing) {
      if ((existing.reason ?? '') === (reason ?? '')) {
        return reply.status(200).send({ dogEar: serializeDogEar(existing), idempotent: true });
      }
      throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
    }

    try {
      const dogEar = await prisma.$transaction(async (tx) => {
        const created = await tx.dogEar.create({
          data: { userId, bookId, pageNumber: parsed.data.pageNumber, reason }
        });
        await writeEvent(tx, {
          userId,
          bookId,
          entityType: 'DOG_EAR',
          entityId: created.id,
          action: 'CREATED',
          payload: { pageNumber: created.pageNumber, reason: eventSummary(created.reason) }
        });
        return created;
      });
      return reply.status(201).send({ dogEar: serializeDogEar(dogEar) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有折角，请编辑原记录');
      }
      throw error;
    }
  });

  app.patch('/dog-ears/:dogEarId', async (request) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const parsed = dogEarUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '折角信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.dogEar.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '折角不存在');
    assertVersion(existing.version, parsed.data.version);
    const nextPage = parsed.data.pageNumber ?? existing.pageNumber;
    validateSinglePage(nextPage, existing.book.pageCount);
    const nextReason =
      parsed.data.reason === undefined
        ? existing.reason
        : parsed.data.reason
          ? normalizeText(parsed.data.reason)
          : null;
    if (nextPage !== existing.pageNumber) {
      const duplicate = await prisma.dogEar.findFirst({
        where: { bookId: existing.bookId, pageNumber: nextPage, deletedAt: null, id: { not: id } }
      });
      if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '目标页已有折角');
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.dogEar.updateMany({
        where: { id, userId, version: existing.version, deletedAt: null },
        data: {
          pageNumber: nextPage,
          reason: nextReason,
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '折角已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        action: 'UPDATED',
        payload: { pageNumber: nextPage, reason: eventSummary(nextReason) }
      });
      return tx.dogEar.findUniqueOrThrow({ where: { id } });
    });
    return { dogEar: serializeDogEar(updated) };
  });

  app.delete('/dog-ears/:dogEarId', async (request, reply) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.dogEar.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '折角不存在');
    assertVersion(existing.version, parsed.data?.version);
    await prisma.$transaction(async (tx) => {
      const result = await tx.dogEar.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '折角已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        action: 'DELETED',
        payload: { pageNumber: existing.pageNumber }
      });
    });
    return reply.status(204).send();
  });

  app.post('/dog-ears/:dogEarId/restore', async (request) => {
    const id = parseId((request.params as { dogEarId: string }).dogEarId, 'dogEarId');
    const userId = currentUser(request).id;
    const existing = await prisma.dogEar.findFirst({ where: { id, userId }, include: { book: true } });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除折角不存在');
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
    const duplicate = await prisma.dogEar.findFirst({
      where: { bookId: existing.bookId, pageNumber: existing.pageNumber, deletedAt: null, id: { not: id } }
    });
    if (duplicate) throw new AppError(409, 'DOG_EAR_EXISTS', '该页已有有效折角，无法恢复');
    const restored = await prisma.$transaction(async (tx) => {
      const value = await tx.dogEar.update({
        where: { id },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId: value.bookId,
        entityType: 'DOG_EAR',
        entityId: id,
        action: 'RESTORED',
        payload: { pageNumber: value.pageNumber }
      });
      return value;
    });
    return { dogEar: serializeDogEar(restored) };
  });

  app.post('/books/:bookId/annotations', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = annotationCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '批注信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validatePageRange(parsed.data.startPage, parsed.data.endPage, book.pageCount);
    const annotation = await prisma.$transaction(async (tx) => {
      const created = await tx.annotation.create({
        data: {
          userId,
          bookId,
          startPage: parsed.data.startPage,
          endPage: parsed.data.endPage,
          content: normalizeText(parsed.data.content)
        }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'ANNOTATION',
        entityId: created.id,
        action: 'CREATED',
        payload: { startPage: created.startPage, endPage: created.endPage, summary: eventSummary(created.content) }
      });
      return created;
    });
    return reply.status(201).send({ annotation: serializeAnnotation(annotation) });
  });

  app.patch('/annotations/:annotationId', async (request) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const parsed = annotationUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '批注信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.annotation.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '批注不存在');
    assertVersion(existing.version, parsed.data.version);
    const startPage = parsed.data.startPage ?? existing.startPage;
    const endPage = parsed.data.endPage ?? existing.endPage;
    validatePageRange(startPage, endPage, existing.book.pageCount);
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.annotation.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: {
          startPage,
          endPage,
          ...(parsed.data.content !== undefined ? { content: normalizeText(parsed.data.content) } : {}),
          version: { increment: 1 }
        }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '批注已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        action: 'UPDATED',
        payload: { startPage, endPage }
      });
      return tx.annotation.findUniqueOrThrow({ where: { id } });
    });
    return { annotation: serializeAnnotation(updated) };
  });

  app.delete('/annotations/:annotationId', async (request, reply) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.annotation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '批注不存在');
    assertVersion(existing.version, parsed.data?.version);
    await prisma.$transaction(async (tx) => {
      const result = await tx.annotation.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '批注已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        action: 'DELETED',
        payload: { startPage: existing.startPage, endPage: existing.endPage }
      });
    });
    return reply.status(204).send();
  });

  app.post('/annotations/:annotationId/restore', async (request) => {
    const id = parseId((request.params as { annotationId: string }).annotationId, 'annotationId');
    const userId = currentUser(request).id;
    const existing = await prisma.annotation.findFirst({ where: { id, userId }, include: { book: true } });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除批注不存在');
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
    const restored = await prisma.$transaction(async (tx) => {
      const value = await tx.annotation.update({
        where: { id },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId: value.bookId,
        entityType: 'ANNOTATION',
        entityId: id,
        action: 'RESTORED',
        payload: { startPage: value.startPage, endPage: value.endPage }
      });
      return value;
    });
    return { annotation: serializeAnnotation(restored) };
  });

  app.post('/books/:bookId/reread-marks', async (request, reply) => {
    const bookId = parseId((request.params as { bookId: string }).bookId, 'bookId');
    const parsed = rereadCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '重读信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const book = await prisma.book.findFirst({ where: { id: bookId, userId, deletedAt: null } });
    if (!book) throw new AppError(404, 'NOT_FOUND', '书目不存在');
    validateSinglePage(parsed.data.pageNumber, book.pageCount);
    const mark = await prisma.$transaction(async (tx) => {
      // 以 (书目, 页码) 为粒度串行化轮次分配，并发提交也能得到连续、不撞号的轮次。
      const lockRows = await tx.$queryRaw<{ lockKey: bigint }[]>`
        SELECT hashtextextended(
          ${bookId}::text || ':' || ${parsed.data.pageNumber}::text, 0
        ) AS "lockKey"
      `;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockRows[0]!.lockKey})`;
      const latest = await tx.rereadMark.aggregate({
        where: { bookId, pageNumber: parsed.data.pageNumber },
        _max: { rereadRound: true }
      });
      const rereadRound = (latest._max.rereadRound ?? 0) + 1;
      const created = await tx.rereadMark.create({
        data: {
          userId,
          bookId,
          pageNumber: parsed.data.pageNumber,
          rereadRound,
          reason: parsed.data.reason ? normalizeText(parsed.data.reason) : null
        }
      });
      await writeEvent(tx, {
        userId,
        bookId,
        entityType: 'REREAD_MARK',
        entityId: created.id,
        action: 'CREATED',
        payload: {
          pageNumber: created.pageNumber,
          rereadRound,
          reason: eventSummary(created.reason)
        }
      });
      return created;
    });
    return reply.status(201).send({ rereadMark: serializeRereadMark(mark) });
  });

  app.patch('/reread-marks/:rereadMarkId', async (request) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const parsed = rereadUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '重读信息无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.rereadMark.findFirst({
      where: { id, userId, deletedAt: null },
      include: { book: true }
    });
    if (!existing || existing.book.deletedAt) throw new AppError(404, 'NOT_FOUND', '重读记录不存在');
    assertVersion(existing.version, parsed.data.version);
    const pageNumber = parsed.data.pageNumber ?? existing.pageNumber;
    validateSinglePage(pageNumber, existing.book.pageCount);
    const reason =
      parsed.data.reason === undefined
        ? existing.reason
        : parsed.data.reason
          ? normalizeText(parsed.data.reason)
          : null;
    const updated = await prisma.$transaction(async (tx) => {
      const lockRows = await tx.$queryRaw<{ lockKey: bigint }[]>`
        SELECT hashtextextended(
          ${existing.bookId}::text || ':' || ${pageNumber}::text, 0
        ) AS "lockKey"
      `;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockRows[0]!.lockKey})`;
      let rereadRound = existing.rereadRound;
      if (pageNumber !== existing.pageNumber) {
        const latest = await tx.rereadMark.aggregate({
          where: {
            bookId: existing.bookId,
            pageNumber,
            id: { not: id }
          },
          _max: { rereadRound: true }
        });
        rereadRound = (latest._max.rereadRound ?? 0) + 1;
      }
      const result = await tx.rereadMark.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { pageNumber, rereadRound, reason, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '重读记录已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        action: 'UPDATED',
        payload: { pageNumber, rereadRound, reason: eventSummary(reason) }
      });
      return tx.rereadMark.findUniqueOrThrow({ where: { id } });
    });
    return { rereadMark: serializeRereadMark(updated) };
  });

  app.delete('/reread-marks/:rereadMarkId', async (request, reply) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '删除参数无效', zodFields(parsed.error));
    const userId = currentUser(request).id;
    const existing = await prisma.rereadMark.findFirst({ where: { id, userId, deletedAt: null } });
    if (!existing) throw new AppError(404, 'NOT_FOUND', '重读记录不存在');
    assertVersion(existing.version, parsed.data?.version);
    await prisma.$transaction(async (tx) => {
      const result = await tx.rereadMark.updateMany({
        where: { id, userId, deletedAt: null, version: existing.version },
        data: { deletedAt: new Date(), version: { increment: 1 } }
      });
      if (result.count !== 1) throw new AppError(409, 'STALE_WRITE', '重读记录已在其他位置被修改');
      await writeEvent(tx, {
        userId,
        bookId: existing.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        action: 'DELETED',
        payload: { pageNumber: existing.pageNumber, rereadRound: existing.rereadRound }
      });
    });
    return reply.status(204).send();
  });

  app.post('/reread-marks/:rereadMarkId/restore', async (request) => {
    const id = parseId((request.params as { rereadMarkId: string }).rereadMarkId, 'rereadMarkId');
    const userId = currentUser(request).id;
    const existing = await prisma.rereadMark.findFirst({ where: { id, userId }, include: { book: true } });
    if (!existing || !existing.deletedAt) throw new AppError(404, 'NOT_FOUND', '已删除重读记录不存在');
    if (!isRestoreWindowOpen(existing.deletedAt)) {
      throw new AppError(409, 'RESTORE_WINDOW_EXPIRED', '已超过 24 小时恢复窗口');
    }
    if (existing.book.deletedAt) throw new AppError(409, 'BOOK_DELETED', '所属书目已删除');
    const restored = await prisma.$transaction(async (tx) => {
      const value = await tx.rereadMark.update({
        where: { id },
        data: { deletedAt: null, version: { increment: 1 } }
      });
      await writeEvent(tx, {
        userId,
        bookId: value.bookId,
        entityType: 'REREAD_MARK',
        entityId: id,
        action: 'RESTORED',
        payload: { pageNumber: value.pageNumber, rereadRound: value.rereadRound }
      });
      return value;
    });
    return { rereadMark: serializeRereadMark(restored) };
  });
};
