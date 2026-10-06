import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NOTHING IN THIS REPOSITORY NAMES THE ADD-ON'S REPOSITORY.
 *
 * This repo is the free product and is public: it describes what it serves and frames, never the
 * repository of whatever is mounted on the other side. The embed bundle has its own scan
 * (`pay-embed.test.ts`); this one covers every tracked file, so a mention in a doc, a workflow, a
 * config or a server comment is caught the same way. The name is assembled from its halves so that
 * this file is not itself an offender.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const NAME = new RegExp(['pawservation', 'premium'].join('[-_]'), 'i');

/** Tracked files only: `node_modules`, build output and local scratch are untracked by definition. */
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

/** A NUL byte in the first 8 KiB is the usual test for "not text" (images, fonts). */
const textOf = (path: string): string | null => {
  let buf: Buffer;
  try {
    buf = readFileSync(join(ROOT, path));
  } catch {
    return null; // listed but deleted in the working tree
  }
  return buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8');
};

describe('no tracked file names the add-on repository', () => {
  it('scans the whole tracked tree, and finds nothing', () => {
    const offenders = tracked.filter((path) => {
      const text = textOf(path);
      return text !== null && NAME.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('is not vacuous: it sees source, docs and workflows, and would match the name', () => {
    expect(tracked.length).toBeGreaterThan(100);
    expect(tracked).toContain('server/index.ts');
    expect(tracked).toContain('README.md');
    expect(NAME.test(['pawservation', 'premium'].join('-'))).toBe(true);
    expect(NAME.test(['Pawservation', 'Premium'].join('_'))).toBe(true);
  });
});
