import { describe, expect, it } from 'vitest';
import { parseCsvRows } from '../lib/csv';

describe('parseCsvRows', () => {
  it('splits a simple comma-separated file into rows and cells', () => {
    const text = 'a,b,c\n1,2,3';
    expect(parseCsvRows(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles a quoted field containing a comma', () => {
    const text = 'Client Email,Client Name\njess@example.com,"Doe, Jane"';
    expect(parseCsvRows(text)).toEqual([
      ['Client Email', 'Client Name'],
      ['jess@example.com', 'Doe, Jane'],
    ]);
  });

  it('un-escapes doubled quotes inside a quoted field', () => {
    const text = 'a\n"She said ""hi"""';
    expect(parseCsvRows(text)).toEqual([['a'], ['She said "hi"']]);
  });

  it('tolerates CRLF line endings', () => {
    const text = 'a,b\r\n1,2';
    expect(parseCsvRows(text)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('represents a blank line as a single empty-string cell, preserving row alignment', () => {
    const text = 'a,b\n\n1,2\n\n';
    expect(parseCsvRows(text)).toEqual([['a', 'b'], [''], ['1', '2'], [''], ['']]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseCsvRows('')).toEqual([]);
  });
});
