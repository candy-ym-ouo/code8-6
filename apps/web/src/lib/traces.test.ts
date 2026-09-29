import { describe, expect, it, vi } from 'vitest';
import {
  aggregateRereadMarks,
  distinctRereadReasons,
  EMPTY_REASON,
  fetchAllPages,
  filterRereadGroups,
  type PageResponse
} from './traces';
import type { RereadMark } from '../types/domain';

function mark(
  id: string,
  pageNumber: number,
  createdAt: string,
  reason: string | null = null,
  roundWithinPage = 1
): RereadMark {
  return {
    id,
    bookId: 'book-1',
    type: 'REREAD_MARK',
    pageNumber,
    roundWithinPage,
    reason,
    version: 1,
    createdAt,
    updatedAt: createdAt
  };
}

describe('fetchAllPages', () => {
  function pageOf(records: Array<{ id: string }>, page: number, pageSize: number, total: number): PageResponse<any> {
    return {
      items: records.slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, total }
    };
  }

  it('fetches every page and returns all records', async () => {
    const records = Array.from({ length: 25 }, (_, index) => ({ id: `r${index}` }));
    const fetchPage = vi.fn(async (page: number, pageSize: number) => pageOf(records, page, pageSize, records.length));

    const result = await fetchAllPages(fetchPage, 10);
    expect(result).toHaveLength(25);
    expect(new Set(result.map((item) => item.id)).size).toBe(25);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops without an extra request when unique ids cover the total', async () => {
    const records = Array.from({ length: 20 }, (_, index) => ({ id: `r${index}` }));
    const fetchPage = vi.fn(async (page: number, pageSize: number) => pageOf(records, page, pageSize, records.length));

    const result = await fetchAllPages(fetchPage, 10);
    expect(result).toHaveLength(20);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list without requesting beyond the first empty page', async () => {
    const fetchPage = vi.fn(async (page: number, pageSize: number) => pageOf([], page, pageSize, 0));
    const result = await fetchAllPages(fetchPage, 10);
    expect(result).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('dedupes overlapping pages instead of counting overlap toward total', async () => {
    // 翻页时列表整体后移一条，相邻页重复一行：累加长度会提前误判完成，
    // 把真正的尾项 d 漏掉；按唯一 id 计数则继续取到 d 后再结束。
    const fetchPage = vi.fn(async (page: number, pageSize: number): PageResponse<{ id: string }> => {
      const pages: string[][] = [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd']
      ];
      const items = pages[page - 1] ?? [];
      return { items: items.map((id) => ({ id })), pagination: { page, pageSize, total: 4 } };
    });

    const result = await fetchAllPages(fetchPage, 2);
    expect(result.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('aggregateRereadMarks', () => {
  it('groups by page and orders rounds by the server-assigned round', () => {
    const groups = aggregateRereadMarks([
      mark('c', 10, '2026-09-03T00:00:00Z', '第三次', null, 3),
      mark('a', 10, '2026-09-01T00:00:00Z', '第一次', null, 1),
      mark('b', 10, '2026-09-02T00:00:00Z', '第二次', null, 2),
      mark('d', 20, '2026-09-04T00:00:00Z', null, 1)
    ]);

    expect(groups.map((group) => group.pageNumber)).toEqual([10, 20]);
    expect(groups[0].marks.map((item) => [item.id, item.round])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3]
    ]);
    expect(groups[1].marks[0].round).toBe(1);
  });

  it('orders by round even when two marks share a timestamp', () => {
    // 连续快速创建可能撞在同一毫秒：页内轮次保证先后不依赖随机 UUID。
    const groups = aggregateRereadMarks([
      mark('b', 5, '2026-09-01T00:00:00.000Z', null, 2),
      mark('a', 5, '2026-09-01T00:00:00.000Z', null, 1)
    ]);
    expect(groups[0].marks.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('keeps historical round numbers after a deletion', () => {
    const marks = [
      mark('a', 3, '2026-09-01T00:00:00Z', null, 1),
      mark('b', 3, '2026-09-02T00:00:00Z', null, 2),
      mark('c', 3, '2026-09-03T00:00:00Z', null, 3)
    ];
    // 删除中间一轮后重新拉取聚合：第 3 轮仍是第 3 轮，顺序与编号不被重排。
    const groups = aggregateRereadMarks(marks.filter((item) => item.id !== 'b'));
    expect(groups[0].marks.map((item) => item.round)).toEqual([1, 3]);
    expect(groups[0].marks.map((item) => item.id)).toEqual(['a', 'c']);
  });
});

describe('filterRereadGroups', () => {
  const groups = aggregateRereadMarks([
    mark('a', 1, '2026-09-01T00:00:00Z', '金句', 1),
    mark('b', 1, '2026-09-02T00:00:00Z', null, 2),
    mark('e', 1, '2026-09-05T00:00:00Z', '金句', 3),
    mark('c', 2, '2026-09-03T00:00:00Z', '金句', 1),
    mark('d', 3, '2026-09-04T00:00:00Z', null, 1)
  ]);

  it('keeps the real round numbers (with gaps) when filtering one reason', () => {
    const filtered = filterRereadGroups(groups, '金句');
    expect(filtered.map((group) => group.pageNumber)).toEqual([1, 2]);
    expect(filtered[0].marks.map((item) => item.round)).toEqual([1, 3]);
    expect(filtered[1].marks[0].round).toBe(1);
  });

  it('can select only marks without a reason and drops emptied groups', () => {
    const filtered = filterRereadGroups(groups, EMPTY_REASON);
    expect(filtered.map((group) => group.pageNumber)).toEqual([1, 3]);
    expect(filtered.every((group) => group.marks.every((item) => !item.reason))).toBe(true);
    expect(filtered[0].marks[0].round).toBe(2);
  });

  it('returns groups unchanged without a filter', () => {
    expect(filterRereadGroups(groups, '')).toBe(groups);
  });
});

describe('distinctRereadReasons', () => {
  it('lists unique reasons in first-occurrence order', () => {
    const reasons = distinctRereadReasons([
      mark('a', 1, '2026-09-03T00:00:00Z', '困惑'),
      mark('b', 1, '2026-09-01T00:00:00Z', '金句'),
      mark('c', 2, '2026-09-02T00:00:00Z', '金句'),
      mark('d', 3, '2026-09-04T00:00:00Z', '  '),
      mark('e', 3, '2026-09-05T00:00:00Z', null)
    ]);
    expect(reasons).toEqual(['金句', '困惑']);
  });
});
