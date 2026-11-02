import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { catalogProblems, entryProblems, parseCatalogJson, runtimeProblems } from '../check-catalog.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const script = join(here, '..', 'check-catalog.mjs');
const catalogPath = join(here, '..', '..', '..', 'model-catalog', 'catalog.json');
// Read as the checker reads a catalog, so `3.0` in a case stays a float.
const {
  bases,
  cases,
  runtime_bases: runtimeBases,
  runtime_cases: runtimeCases,
} = parseCatalogJson(readFileSync(join(here, 'entry-cases.json'), 'utf8'));

// The base entry with the case's dotted paths set and removed.
function caseEntry({ base, set = {}, remove = [] }, from = bases) {
  const entry = structuredClone(from[base]);
  const walk = (path) => {
    const keys = path.split('.');
    const last = keys.pop();
    return [keys.reduce((node, key) => node[key], entry), last];
  };
  for (const [path, value] of Object.entries(set)) {
    const [node, key] = walk(path);
    node[key] = value;
  }
  for (const path of remove) {
    const [node, key] = walk(path);
    delete node[key];
  }
  return entry;
}

for (const shared of cases) {
  test(`shared case: ${shared.name}`, () => {
    const problems = entryProblems(caseEntry(shared));
    assert.equal(problems.length === 0, shared.valid, problems.join('; '));
  });
}

for (const shared of runtimeCases) {
  test(`shared runtime case: ${shared.name}`, () => {
    const problems = runtimeProblems(caseEntry(shared, runtimeBases));
    assert.equal(problems.length === 0, shared.valid, problems.join('; '));
  });
}

test('the repository catalog is valid', () => {
  const { fatal, problems } = catalogProblems(parseCatalogJson(readFileSync(catalogPath, 'utf8')));
  assert.equal(fatal, null);
  assert.deepEqual(problems, []);
});

test('an unknown schema or a document without models cannot be used at all', () => {
  assert.match(catalogProblems({ schema: 2, models: [] }).fatal, /schema 2/);
  assert.match(catalogProblems({ schema: 1 }).fatal, /models must be a list/);
  assert.match(catalogProblems([]).fatal, /not a JSON object/);
});

test('numbers are read as the app reads them', () => {
  // serde refuses a float where it expects the integer 1, and any number
  // beyond f64 makes the document unreadable.
  assert.match(catalogProblems(parseCatalogJson('{"schema": 1.0, "models": []}')).fatal, /written as a fraction/);
  assert.throws(() => parseCatalogJson('{"schema": 1, "models": [], "rank": 1e400}'), /out of range/);
  assert.equal(catalogProblems(parseCatalogJson('{"schema": 1, "models": [3.0]}')).problems.length, 1);
});

test('a broken entry is reported on its own and the first of two duplicates is kept', () => {
  const whisper = bases.whisper;
  const llama = bases.llama;
  const renamed = { ...llama, id: 'gemma3:1b-copy' };
  const { fatal, problems } = catalogProblems({
    schema: 1,
    models: [whisper, { ...whisper, name: '' }, whisper, llama, renamed],
  });
  assert.equal(fatal, null);
  assert.deepEqual(
    problems.map(({ index }) => index),
    [1, 2, 4],
  );
  assert.match(problems[1].problem, /whisper\/tiny is listed twice/);
  assert.match(problems[2].problem, /already used by another summary model/);
});

test('an openvino companion must serve ggml whisper models of the same catalog', () => {
  const turbo = { ...bases.whisper, id: 'large-v3-turbo', files: [{ name: 'ggml-large-v3-turbo.bin', path: 'ggml-large-v3-turbo.bin' }] };
  const runtimes = [runtimeBases.openvino];
  assert.deepEqual(catalogProblems({ schema: 1, models: [turbo, bases.openvino], runtimes }).problems, []);
  const { problems } = catalogProblems({ schema: 1, models: [bases.whisper, bases.openvino], runtimes });
  assert.deepEqual(problems.map(({ index }) => index), [1]);
  assert.match(problems[0].problem, /companion_of names large-v3-turbo, which is not a ggml whisper model here/);
});

test('a companion must name a runtime the catalog lists', () => {
  const turbo = { ...bases.whisper, id: 'large-v3-turbo', files: [{ name: 'ggml-large-v3-turbo.bin', path: 'ggml-large-v3-turbo.bin' }] };
  const models = [turbo, bases.openvino];
  assert.deepEqual(catalogProblems({ schema: 1, models, runtimes: [runtimeBases.openvino] }).problems, []);
  const { problems } = catalogProblems({ schema: 1, models });
  assert.deepEqual(problems.map(({ list, index }) => [list, index]), [['models', 1]]);
  assert.match(problems[0].problem, /runtime names openvino-genai, which has no entry in runtimes/);
});

test('runtimes are a list of their own, one entry per runtime, platform and API level', () => {
  const runtime = runtimeBases.openvino;
  const later = { ...runtime, version: '2027.0.0.0', api: 2 };
  assert.deepEqual(catalogProblems({ schema: 1, models: [], runtimes: [runtime, later] }).problems, []);
  const { problems } = catalogProblems({ schema: 1, models: [], runtimes: [runtime, { ...runtime, version: '2026.5.0.0' }, { ...runtime, name: '' }] });
  assert.deepEqual(problems.map(({ list, index }) => [list, index]), [['runtimes', 1], ['runtimes', 2]]);
  assert.match(problems[0].problem, /openvino-genai\/windows-x86_64\/api 1 is listed twice/);
  // Not a list: the runtimes are refused, the models are not.
  const broken = catalogProblems({ schema: 1, models: [bases.whisper], runtimes: {} });
  assert.equal(broken.fatal, null);
  assert.deepEqual(broken.problems.map(({ list, problem }) => [list, problem]), [['runtimes', 'runtimes must be a list']]);
});

test('the command fails on a broken entry and passes the repository catalog', () => {
  assert.match(execFileSync(process.execPath, [script, catalogPath], { encoding: 'utf8' }), /all valid/);
  const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
  const broken = join(dir, 'catalog.json');
  writeFileSync(broken, JSON.stringify({ schema: 1, models: [{ ...bases.whisper, repo: 'nope' }] }));
  assert.throws(
    () => execFileSync(process.execPath, [script, broken], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => /models\[0\] \(tiny\): repo must be/.test(error.stderr),
  );
});
