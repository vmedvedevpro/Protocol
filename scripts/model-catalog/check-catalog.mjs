#!/usr/bin/env node
// Checks model-catalog/catalog.json with the rules the app applies when it
// reads the file (frontend/src-tauri/src/model_catalog/schema.rs). Both sides
// run the shared cases in test/entry-cases.json, so they cannot drift apart.
//
// The app hides an entry that breaks a rule and keeps the others; here any
// broken entry fails the check, so a pull request cannot merge one into main,
// from where installed apps read the catalog.
//
//   node scripts/model-catalog/check-catalog.mjs [model-catalog/catalog.json]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 1;

// Engines and file formats this version of the app can run.
export const ENGINES = {
  whisper: { formats: ['ggml'] },
  parakeet: { formats: ['onnx-tdt-int8'] },
  llama: { formats: ['gguf'] },
};
export const PARAKEET_FILES = ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx', 'nemo128.onnx', 'vocab.txt'];
export const CHAT_FORMATS = ['gemma3', 'qwen3.5_nonthinking'];
export const SAMPLING_FIELDS = [
  'temperature',
  'top_k',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'repeat_penalty',
  'penalty_last_n',
];

const ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LANGUAGE = /^(\*|[a-z]{2,3})$/;
const VERSION = /^\d+\.\d+\.\d+$/;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

// A path inside a Hugging Face repository: relative, no empty, `.` or `..`
// segments, and segments made of the same characters as a file name.
function isRepoPath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 255 &&
    path.split('/').every((segment) => FILE_NAME.test(segment))
  );
}

// The problems of one entry, as sentences; an empty list means the app uses it.
export function entryProblems(entry) {
  const problems = [];
  if (!isObject(entry)) return ['is not an object'];
  const { id, engine } = entry;
  if (typeof id !== 'string' || !ID.test(id)) problems.push('id must be 1-64 lowercase letters, digits, ".", "_", ":" or "-"');
  const known = ENGINES[engine];
  if (!known) problems.push(`engine ${JSON.stringify(engine)} is not supported`);
  else if (!known.formats.includes(entry.format)) problems.push(`format ${JSON.stringify(entry.format)} is not supported by ${engine}`);
  if (!isText(entry.name, 80)) problems.push('name must be a non-empty text of at most 80 characters');
  if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > 300)) {
    problems.push('description must be a text of at most 300 characters');
  }
  if (!Array.isArray(entry.languages) || entry.languages.length === 0 || !entry.languages.every((code) => typeof code === 'string' && LANGUAGE.test(code))) {
    problems.push('languages must list "*" or language codes');
  }
  for (const field of ['accuracy', 'speed']) {
    if (entry[field] !== undefined && !isText(entry[field], 40)) problems.push(`${field} must be a short text`);
  }
  if (entry.tier !== undefined && !['basic', 'advanced'].includes(entry.tier)) problems.push('tier must be "basic" or "advanced"');
  for (const field of ['recommended', 'listed']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'boolean') problems.push(`${field} must be true or false`);
  }
  if (entry.rank !== undefined && !(Number.isInteger(entry.rank) && entry.rank >= 0)) problems.push('rank must be a whole number of 0 or more');
  if (entry.min_ram_gb !== undefined && !(typeof entry.min_ram_gb === 'number' && entry.min_ram_gb > 0)) problems.push('min_ram_gb must be a positive number');
  if (!(Number.isInteger(entry.size_mb) && entry.size_mb > 0)) problems.push('size_mb must be a positive whole number');
  if (!isObject(entry.license) || !isText(entry.license.name, 80) || typeof entry.license.url !== 'string' || !entry.license.url.startsWith('https://')) {
    problems.push('license needs a name and an https url');
  }
  if (typeof entry.repo !== 'string' || !REPO.test(entry.repo)) problems.push('repo must be a Hugging Face repository, owner/name');
  if (entry.revision !== undefined && (typeof entry.revision !== 'string' || !COMMIT.test(entry.revision))) {
    problems.push('revision must be a full 40-character commit id');
  }
  if (entry.min_app_version !== undefined && (typeof entry.min_app_version !== 'string' || !VERSION.test(entry.min_app_version))) {
    problems.push('min_app_version must be X.Y.Z');
  }
  problems.push(...fileProblems(entry, known ? engine : null));
  if (known && engine === 'llama') problems.push(...llamaProblems(entry.params));
  else if (entry.params !== undefined) problems.push(`params are not used by ${engine}`);
  return problems;
}

function fileProblems(entry, engine) {
  const { files } = entry;
  if (!Array.isArray(files) || files.length === 0) return ['files must list at least one file'];
  const problems = [];
  const names = new Set();
  for (const file of files) {
    if (!isObject(file) || typeof file.name !== 'string' || !FILE_NAME.test(file.name) || !isRepoPath(file.path)) {
      problems.push('every file needs a safe name and a relative path in the repository');
      continue;
    }
    if (names.has(file.name)) problems.push(`file ${file.name} is listed twice`);
    names.add(file.name);
  }
  if (problems.length > 0) return problems;
  if (engine === 'whisper' && (files.length !== 1 || files[0].name !== `ggml-${entry.id}.bin`)) {
    problems.push(`a whisper model is one file named ggml-${entry.id}.bin`);
  }
  if (engine === 'parakeet' && (files.length !== PARAKEET_FILES.length || !PARAKEET_FILES.every((name) => names.has(name)))) {
    problems.push(`a parakeet model is the files ${PARAKEET_FILES.join(', ')}`);
  }
  if (engine === 'llama' && (files.length !== 1 || !files[0].name.endsWith('.gguf'))) {
    problems.push('a llama model is one .gguf file');
  }
  return problems;
}

function llamaProblems(params) {
  if (!isObject(params)) return ['params are required for llama'];
  const problems = [];
  if (!CHAT_FORMATS.includes(params.chat_format)) problems.push(`chat_format must be one of ${CHAT_FORMATS.join(', ')}`);
  if (!(Number.isInteger(params.context_size) && params.context_size >= 512 && params.context_size <= 1048576)) {
    problems.push('context_size must be a whole number from 512 to 1048576');
  }
  // llama-helper takes top_k and penalty_last_n as integers.
  const whole = ['top_k', 'penalty_last_n'];
  if (
    !isObject(params.sampling) ||
    !SAMPLING_FIELDS.every((field) => {
      const value = params.sampling[field];
      return whole.includes(field) ? Number.isInteger(value) && Math.abs(value) <= 2 ** 31 - 1 : typeof value === 'number' && Number.isFinite(value);
    })
  ) {
    problems.push(`sampling needs the numbers ${SAMPLING_FIELDS.join(', ')} (top_k and penalty_last_n whole)`);
  }
  if (!Array.isArray(params.stop_tokens) || params.stop_tokens.length === 0 || !params.stop_tokens.every((token) => typeof token === 'string' && token !== '')) {
    problems.push('stop_tokens must list at least one token');
  }
  return problems;
}

// { fatal, problems: [{ index, id, problem }] }. `fatal` is set when the app
// could not use the document at all; otherwise each problem hides one entry.
export function catalogProblems(document) {
  if (!isObject(document)) return { fatal: 'the catalog is not a JSON object', problems: [] };
  if (document.schema !== SCHEMA) return { fatal: `schema ${JSON.stringify(document.schema)} is not ${SCHEMA}`, problems: [] };
  if (!Array.isArray(document.models)) return { fatal: 'models must be a list', problems: [] };
  const problems = [];
  const ids = new Set();
  const ggufNames = new Set();
  document.models.forEach((entry, index) => {
    const id = isObject(entry) ? entry.id : undefined;
    const own = entryProblems(entry);
    if (own.length > 0) {
      own.forEach((problem) => problems.push({ index, id, problem }));
      return;
    }
    // The first of two entries with the same id, or the same GGUF file name
    // (summary models share one folder), is kept.
    const key = `${entry.engine}/${entry.id}`;
    if (ids.has(key)) problems.push({ index, id, problem: `${key} is listed twice` });
    else if (entry.engine === 'llama' && ggufNames.has(entry.files[0].name)) {
      problems.push({ index, id, problem: `${entry.files[0].name} is already used by another summary model` });
    }
    ids.add(key);
    if (entry.engine === 'llama') ggufNames.add(entry.files[0].name);
  });
  return { fatal: null, problems };
}

function main() {
  const path = resolve(process.argv[2] ?? 'model-catalog/catalog.json');
  let document;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exit(1);
  }
  const { fatal, problems } = catalogProblems(document);
  if (fatal) {
    console.error(`${path}: ${fatal}`);
    process.exit(1);
  }
  for (const { index, id, problem } of problems) console.error(`${path}: models[${index}] (${id ?? 'no id'}): ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`${path}: ${document.models.length} models, all valid`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
