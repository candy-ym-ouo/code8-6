import { describe, expect, it } from 'vitest';
import type { Annotation, DogEar, RereadMark } from '../types/domain';
import { groupRereadMarks } from './rereads';

function reread(partial: Partial<RereadMark> & Pick<RereadMark, 'id' | 'pageNumber' | 'rereadRound' | 'createdAt'>): RereadMark {
  return {
    bookId: 'book-1',
    type: 'REREAD_MARK',
    reason: null,
    version: 1,
    updatedAt: partial.createdAt,
    ...partial
  };
}

describe('groupRereadMarks', () => {
  it('aggregates same-page rereads and keeps chronological order via stable round numbers', () => {
    const traces: RereadMark[] = [
      reread({ id: 'b', pageNumber: 12, rereadRound: 2, createdAt: '2026-09-02T00:00:00.000Z' }),
      reread({ id: 'a', pageNumber: 12, rereadRound: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
      reread({ id: 'c', pageNumber: 30, rereadRound: 1, createdAt: '2026-09-03T00:00:00.000Z' })
    ];

    const groups = groupRereadMarks(traces);

    expect(groups.map((group) => group.pageNumber)).toEqual([12, 30]);
    expect(groups[0]?.marks.map((mark) => mark.rereadRound)).toEqual([1, 2]);
  });

  it('keeps ordering visible after a middle round is soft-deleted from the local list', () => {
    const traces: RereadMark[] = [
      reread({ id: 'a', pageNumber: 7, rereadRound: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
      reread({ id: 'c', pageNumber: 7, rereadRound: 3, createdAt: '2026-09-03T00:00:00.000Z' })
    ];

    const groups = groupRereadMarks(traces);

    expect(groups[0]?.marks.map((mark) => mark.rereadRound)).toEqual([1, 3]);
  });

  it('filters by whether a reason was recorded and by keyword', () => {
    const traces: RereadMark[] = [
      reread({ id: 'a', pageNumber: 1, rereadRound: 1, reason: '开头的呼应', createdAt: '2026-09-01T00:00:00.000Z' }),
      reread({ id: 'b', pageNumber: 1, rereadRound: 2, reason: null, createdAt: '2026-09-02T00:00:00.000Z' }),
      reread({ id: 'c', pageNumber: 2, rereadRound: 1, reason: '另一个原因', createdAt: '2026-09-03T00:00:00.000Z' })
    ];

    expect(groupRereadMarks(traces, { reasonFilter: 'WITHOUT_REASON' })[0]?.marks).toHaveLength(1);
    const withReason = groupRereadMarks(traces, { reasonFilter: 'WITH_REASON' });
    expect(withReason.map((group) => group.pageNumber)).toEqual([1, 2]);
    const keywordHits = groupRereadMarks(traces, { reasonFilter: 'WITH_REASON', keyword: '呼应' });
    expect(keywordHits[0]?.marks.map((mark) => mark.id)).toEqual(['a']);
  });

  it('ignores dog ears and annotations while grouping', () => {
    const dogEar = {
      id: 'd', bookId: 'book-1', type: 'DOG_EAR' as const, pageNumber: 12,
      reason: null, version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
    } satisfies DogEar;
    const annotation = {
      id: 'n', bookId: 'book-1', type: 'ANNOTATION' as const, startPage: 12, endPage: 12,
      content: '批注', version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
    } satisfies Annotation;

    expect(groupRereadMarks([dogEar, annotation])).toEqual([]);
  });
});
