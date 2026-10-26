import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { formatLcov, mergeLcov, summarizeLcov } from './lcov.mjs';

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
// --coverage: every process writes coverage/files/<n>/lcov.info, merged into
// coverage/lcov.info at the end (pr-checks.yml uploads it).
const coverage = process.argv.includes('--coverage');
const coverageDir = join(frontend, 'coverage');

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.(?:mjs|js|ts|tsx)$/.test(entry.name) ? [path] : [];
  }).sort();
}

if (!process.versions.bun) {
  throw new Error('Run with pnpm dlx bun@1.3.10 scripts/test-isolated.mjs');
}

const files = testFiles(join(frontend, 'tests'));
if (files.length === 0) throw new Error('No frontend tests found');

// Bun shares global properties and module mocks within one test process.
// A fresh process per file prevents browser/Tauri fixtures leaking into peers.
const failed = [];
if (coverage) rmSync(coverageDir, { recursive: true, force: true });
for (const [index, file] of files.entries()) {
  const label = relative(frontend, file);
  console.log(`Running ${label}`);
  const args = ['test', file];
  if (coverage) {
    args.push('--coverage', '--coverage-reporter=lcov', `--coverage-dir=${join(coverageDir, 'files', String(index))}`);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: frontend,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error);
    failed.push(label);
  }
}

if (coverage) writeCoverage();

console.log(`${files.length - failed.length}/${files.length} isolated test files passed`);
if (failed.length) {
  console.error(`Failed files:\n${failed.join('\n')}`);
  process.exitCode = 1;
}

function writeCoverage() {
  const reports = files
    .map((_, index) => join(coverageDir, 'files', String(index), 'lcov.info'))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'));
  // Bun also reports the test files and the scripts they load; only the app counts.
  const merged = mergeLcov(reports, (path) => path.startsWith('src/'));
  mkdirSync(coverageDir, { recursive: true });
  writeFileSync(join(coverageDir, 'lcov.info'), formatLcov(merged));
  // Bun lists only the files a test loads, so the total leaves out untested
  // modules nothing imports.
  const { files: count, lines, hit, percent } = summarizeLcov(merged);
  const summary = `Frontend line coverage: ${percent.toFixed(1)}% (${hit} of ${lines} lines in ${count} files loaded by the tests)`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
