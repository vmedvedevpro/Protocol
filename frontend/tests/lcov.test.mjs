import { describe, expect, test } from 'bun:test';
import { formatLcov, mergeLcov, summarizeLcov } from '../scripts/lcov.mjs';

// Two isolated test processes that both load src/lib/labs.ts, as Bun writes
// them on Windows (backslash paths) and on Linux.
const windowsReport = [
  'TN:',
  'SF:src\\lib\\labs.ts',
  'FNF:5',
  'FNH:3',
  'DA:10,4',
  'DA:11,0',
  'DA:12,0',
  'LF:3',
  'LH:1',
  'end_of_record',
  'TN:',
  'SF:tests\\labs.test.ts',
  'FNF:1',
  'FNH:1',
  'DA:1,1',
  'LF:1',
  'LH:1',
  'end_of_record',
].join('\r\n');
const linuxReport = [
  'TN:',
  'SF:src/lib/labs.ts',
  'FNF:5',
  'FNH:2',
  'DA:10,1',
  'DA:11,2',
  'DA:12,0',
  'DA:13,0',
  'LF:4',
  'LH:2',
  'end_of_record',
  'TN:',
  'SF:src/lib/other.ts',
  'FNF:1',
  'FNH:0',
  'DA:1,0',
  'LF:1',
  'LH:0',
  'end_of_record',
  '',
].join('\n');

describe('lcov merge for isolated test processes', () => {
  test('a line is covered when any process ran it, and test files can be left out', () => {
    const merged = mergeLcov([windowsReport, linuxReport], (path) => !path.startsWith('tests/'));
    expect([...merged.keys()]).toEqual(['src/lib/labs.ts', 'src/lib/other.ts']);
    const labs = merged.get('src/lib/labs.ts');
    expect([...labs.lines]).toEqual([[10, 5], [11, 2], [12, 0], [13, 0]]);
    // Function records carry no names, so only the larger count is known.
    expect([labs.fnf, labs.fnh]).toEqual([5, 3]);
    expect(summarizeLcov(merged)).toEqual({ files: 2, lines: 5, hit: 2, percent: 40 });
  });

  test('writes sorted records with recomputed line totals', () => {
    const merged = mergeLcov([linuxReport, windowsReport], (path) => path !== 'src/lib/other.ts');
    expect(formatLcov(merged)).toBe([
      'TN:',
      'SF:src/lib/labs.ts',
      'FNF:5',
      'FNH:3',
      'DA:10,5',
      'DA:11,2',
      'DA:12,0',
      'DA:13,0',
      'LF:4',
      'LH:2',
      'end_of_record',
      'TN:',
      'SF:tests/labs.test.ts',
      'FNF:1',
      'FNH:1',
      'DA:1,1',
      'LF:1',
      'LH:1',
      'end_of_record',
      '',
    ].join('\n'));
  });

  test('an empty run gives an empty report and no coverage', () => {
    const merged = mergeLcov([]);
    expect(formatLcov(merged)).toBe('');
    expect(summarizeLcov(merged)).toEqual({ files: 0, lines: 0, hit: 0, percent: 0 });
  });
});
