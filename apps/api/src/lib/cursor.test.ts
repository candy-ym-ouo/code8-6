import { describe, expect, it } from 'vitest';
import { decodeTraceCursor, encodeTraceCursor } from './cursor.js';
import { AppError } from './errors.js';

describe('trace cursor', () => {
  it('round-trips a sort key without exposing page numbers', () => {
    const cursor = { createdAtValue: 1_780_000_000_123, id: '0d4f2b1e-7c3a-4a9b-8f2d-1a2b3c4d5e6f' };
    const encoded = encodeTraceCursor(cursor);

    expect(encoded).not.toContain(String(cursor.createdAtValue));
    expect(decodeTraceCursor(encoded)).toEqual(cursor);
  });

  it('treats empty values as no cursor', () => {
    expect(decodeTraceCursor(undefined)).toBeUndefined();
    expect(decodeTraceCursor('')).toBeUndefined();
    expect(decodeTraceCursor(null)).toBeUndefined();
  });

  it('rejects malformed cursors with a validation error', () => {
    expect(() => decodeTraceCursor('not-base64-json')).toThrow(AppError);
    expect(() => decodeTraceCursor(Buffer.from(JSON.stringify({ c: -1, i: 'not-uuid' })).toString('base64url'))).toThrow(
      AppError
    );
  });
});
