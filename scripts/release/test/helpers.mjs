import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// A temporary directory removed after the callback, also when it throws.
export async function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-release-test-'));
  try {
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
