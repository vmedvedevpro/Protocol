// Merges the lcov reports that test-isolated.mjs collects, one per test
// process. Bun 1.3 writes SF, FNF/FNH, DA, LF/LH records only: lines merge
// exactly (a line counts as covered when any process ran it), but function
// totals carry no names, so the merged FNF/FNH is the per-file maximum, a lower
// bound of the real union. Paths are normalized to forward slashes so a report
// written on Windows reads the same as one from CI.

export function parseLcov(text, files = new Map()) {
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const path = line.slice(3).replaceAll('\\', '/');
      if (!files.has(path)) files.set(path, { lines: new Map(), fnf: 0, fnh: 0 });
      current = files.get(path);
    } else if (!current) {
      continue;
    } else if (line.startsWith('DA:')) {
      const [number, hits] = line.slice(3).split(',').map(Number);
      current.lines.set(number, (current.lines.get(number) ?? 0) + hits);
    } else if (line.startsWith('FNF:')) {
      current.fnf = Math.max(current.fnf, Number(line.slice(4)));
    } else if (line.startsWith('FNH:')) {
      current.fnh = Math.max(current.fnh, Number(line.slice(4)));
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

export function mergeLcov(texts, include = () => true) {
  const files = new Map();
  for (const text of texts) parseLcov(text, files);
  for (const path of files.keys()) {
    if (!include(path)) files.delete(path);
  }
  return files;
}

export function formatLcov(files) {
  const records = [...files.keys()].sort().map((path) => {
    const { lines, fnf, fnh } = files.get(path);
    const numbers = [...lines.keys()].sort((a, b) => a - b);
    const hit = numbers.filter((number) => lines.get(number) > 0).length;
    return [
      'TN:',
      `SF:${path}`,
      `FNF:${fnf}`,
      `FNH:${fnh}`,
      ...numbers.map((number) => `DA:${number},${lines.get(number)}`),
      `LF:${numbers.length}`,
      `LH:${hit}`,
      'end_of_record',
    ].join('\n');
  });
  return records.length ? `${records.join('\n')}\n` : '';
}

export function summarizeLcov(files) {
  let lines = 0;
  let hit = 0;
  for (const file of files.values()) {
    lines += file.lines.size;
    for (const hits of file.lines.values()) if (hits > 0) hit += 1;
  }
  return { files: files.size, lines, hit, percent: lines ? (100 * hit) / lines : 0 };
}
