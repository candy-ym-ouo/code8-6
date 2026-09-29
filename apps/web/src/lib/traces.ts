import type { RereadMark } from '../types/domain';

export interface PageResponse<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number };
}

/**
 * 顺序拉取偏移分页的全部记录。
 *
 * 翻页过程中若发生新增（新记录插入列表头部），后续页会整体后移，边界上会
 * 重复上一页最后一条；若用累加长度判断终止，重复项会顶掉真正的新记录。
 * 这里按 id 去重，并以“唯一数量是否已达到最新 total”判断终止：
 * - 重复项不计数，因此新记录仍会从后续页补齐，不漏项；
 * - 某一页没有带来新 id 时按空转处理，避免数据变动导致死循环。
 */
export async function fetchAllPages<T extends { id: string }>(
  fetchPage: (page: number, pageSize: number) => Promise<PageResponse<T>>,
  pageSize = 100,
  maxPages = 1000
): Promise<T[]> {
  const byId = new Map<string, T>();
  let total = Infinity;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchPage(page, pageSize);
    total = response.pagination.total;
    if (response.items.length === 0) break;

    const sizeBefore = byId.size;
    for (const item of response.items) byId.set(item.id, item);
    const allNew = byId.size - sizeBefore === response.items.length;

    // 短页说明已是末页；满页且本页全部为新 id 且唯一数量已覆盖最新 total
    // 时，下一页必为空。存在重复（列表在翻页间后移）时不提前结束，继续补齐。
    if (byId.size >= total && (response.items.length < pageSize || allNew)) break;
    // 整页都是重复项且总数未增长：继续翻页只会再次空转。
    if (byId.size === sizeBefore && byId.size >= total) break;
  }

  return [...byId.values()];
}

export interface RereadRound extends RereadMark {
  /** 同页第几次重读，从 1 开始；取后端页内轮次，缺失时退回创建先后。 */
  round: number;
}

export interface RereadGroup {
  pageNumber: number;
  marks: RereadRound[];
}

function withinPageOrder(a: RereadMark, b: RereadMark): number {
  const ra = typeof a.roundWithinPage === 'number' ? a.roundWithinPage : 0;
  const rb = typeof b.roundWithinPage === 'number' ? b.roundWithinPage : 0;
  if (ra !== rb) return ra - rb;
  return a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 把重读记录按页聚合成轮次：同一页的多次重读按页内轮次（创建先后）排列，
 * 不同页按页码升序。轮次由后端在创建时分配，删除不会重排历史轮次，因此
 * 删除某条后重新拉取，剩余记录的先后顺序与编号都保持一致；新记录追加为
 * 该页的下一轮次，计数随分组统计与服务端 traceSummary 同步更新。
 */
export function aggregateRereadMarks(marks: RereadMark[]): RereadGroup[] {
  const byPage = new Map<number, RereadMark[]>();
  for (const mark of marks) {
    const list = byPage.get(mark.pageNumber);
    if (list) list.push(mark);
    else byPage.set(mark.pageNumber, [mark]);
  }

  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageNumber, list]) => ({
      pageNumber,
      marks: [...list]
        .sort(withinPageOrder)
        .map((mark) => ({ ...mark, round: mark.roundWithinPage }))
    }));
}

/** 筛选项里代表“未填写原因”的哨兵值。 */
export const EMPTY_REASON = '__EMPTY_REASON__';

/**
 * 从未筛选的聚合结果中按原因保留记录，空组随之消失。轮次编号取后端页内序号
 * （删除后可能不连续），因此筛选视图与全量视图看到的先后、编号完全一致。
 */
export function filterRereadGroups(groups: RereadGroup[], reasonFilter: string): RereadGroup[] {
  if (!reasonFilter) return groups;
  const wantEmpty = reasonFilter === EMPTY_REASON;
  return groups
    .map((group) => ({
      ...group,
      marks: group.marks.filter((mark) => (wantEmpty ? !mark.reason : mark.reason === reasonFilter))
    }))
    .filter((group) => group.marks.length > 0);
}

/** 列出可筛选的重读原因：按全局创建先后去重，空原因不在此列。 */
export function distinctRereadReasons(marks: RereadMark[]): string[] {
  const seen = new Set<string>();
  const reasons: string[] = [];
  const byTime = (a: RereadMark, b: RereadMark): number =>
    a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const mark of [...marks].sort(byTime)) {
    const reason = mark.reason?.trim();
    if (reason && !seen.has(reason)) {
      seen.add(reason);
      reasons.push(reason);
    }
  }
  return reasons;
}
