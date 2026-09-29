import { z } from 'zod';
import { AppError } from './errors.js';

const cursorSchema = z.object({
  c: z.number().int().nonnegative(),
  i: z.string().uuid()
});

export type TraceCursor = { createdAtValue: number; id: string };

/** 游标只承载排序键，不承载页码；新增记录天然落在结果集开头，不会挤掉后续页。 */
export function encodeTraceCursor(cursor: TraceCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAtValue, i: cursor.id }), 'utf8').toString('base64url');
}

export function decodeTraceCursor(value: unknown): TraceCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new AppError(422, 'VALIDATION_ERROR', '分页游标无效', { cursor: '分页游标无效' });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(422, 'VALIDATION_ERROR', '分页游标无效', { cursor: '分页游标无效' });
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_ERROR', '分页游标无效', { cursor: '分页游标无效' });
  }
  return { createdAtValue: parsed.data.c, id: parsed.data.i };
}
