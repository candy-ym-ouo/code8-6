import type { RereadMark, Trace } from '../types/domain';

export type RereadReasonFilter = 'ALL' | 'WITH_REASON' | 'WITHOUT_REASON';

export interface RereadGroup {
  pageNumber: number;
  marks: RereadMark[];
}

function isReread(trace: Trace): trace is RereadMark {
  return trace.type === 'REREAD_MARK';
}

/** 同一页的多次重读聚合成组；组内按创建先后排列，即使删除中间轮次，先后也保持不变。 */
export function groupRereadMarks(
  traces: Trace[],
  options: { reasonFilter?: RereadReasonFilter; keyword?: string } = {}
): RereadGroup[] {
  const reasonFilter = options.reasonFilter ?? 'ALL';
  const keyword = options.keyword?.trim().toLocaleLowerCase() ?? '';
  const matches = (trace: Trace): trace is RereadMark => {
    if (!isReread(trace)) return false;
    const reason = trace.reason ?? '';
    if (reasonFilter === 'WITH_REASON' && !reason) return false;
    if (reasonFilter === 'WITHOUT_REASON' && reason) return false;
    if (keyword && !reason.toLocaleLowerCase().includes(keyword)) return false;
    return true;
  };

  const byPage = new Map<number, RereadMark[]>();
  for (const trace of traces) {
    if (!matches(trace)) continue;
    const list = byPage.get(trace.pageNumber) ?? [];
    list.push(trace);
    byPage.set(trace.pageNumber, list);
  }

  return [...byPage.entries()]
    .map(([pageNumber, list]) => {
      const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { pageNumber, marks: ordered };
    })
    .sort((a, b) => a.pageNumber - b.pageNumber);
}
