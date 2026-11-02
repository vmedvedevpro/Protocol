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
  whisper: { formats: ['ggml', 'openvino-ir'] },
  parakeet: { formats: ['onnx-tdt-int8'] },
  llama: { formats: ['gguf'] },
};
export const PARAKEET_FILES = ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx', 'nemo128.onnx', 'vocab.txt'];
// An OpenVINO companion of Whisper models (#79): the files GenAI's
// WhisperPipeline reads.
export const OPENVINO_IR = 'openvino-ir';
export const OPENVINO_WHISPER_FILES = [
  'openvino_encoder_model.xml',
  'openvino_encoder_model.bin',
  'openvino_decoder_model.xml',
  'openvino_decoder_model.bin',
  'openvino_tokenizer.xml',
  'openvino_tokenizer.bin',
  'openvino_detokenizer.xml',
  'openvino_detokenizer.bin',
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
];
// Inference runtimes this version of the app can load (#79), by id: the
// platforms it loads each on, the files it must list (the libraries its
// binding opens by name, and the auto-batching plugin, which OpenVINO would
// otherwise look for in the current directory), and the only host its archive comes from (over https; the catalog is not
// signed, so a commit can pick a version but not a server). A runtime is not
// a model: it sits in the document's `runtimes` list, which apps before 0.5.0
// never read.
export const RUNTIMES = {
  'openvino-genai': {
    platforms: ['windows-x86_64'],
    files: ['openvino_genai_c.dll', 'openvino_c.dll', 'openvino_auto_batch_plugin.dll'],
    host: 'storage.openvinotoolkit.org',
  },
};
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
const RUNTIME_VERSION = /^\d+\.\d+\.\d+(\.\d+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ZIP_URL = /^https:\/\/([^/?#:@]+)\/[^?#]*\.zip$/;
// Names a runtime file cannot take in its version folder: the install's own
// files and Windows device names, which open a device in any folder.
const RESERVED_RUNTIME_FILES = ['runtime.json', 'archive.zip'];
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const isRuntimeFileName = (name) =>
  FILE_NAME.test(name) &&
  !name.endsWith('.') &&
  !DEVICE_NAME.test(name) &&
  !RESERVED_RUNTIME_FILES.includes(name.toLowerCase()) &&
  !name.toLowerCase().endsWith('.verified');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Number);
const isText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

// Numbers as the app's reader (serde) takes them. A whole-number field
// (u32/i32) refuses a number written with a fraction or an exponent (`3.0`,
// `1e3`) and one outside its range; a float field (f32) turns a number beyond
// its range into infinity, which the app's rules refuse. JavaScript reads
// `3.0` as 3, so parseCatalogJson boxes such numbers (`new Number(3)`): they
// still count as numbers here, never as whole ones.
const U32 = [0, 2 ** 32 - 1];
// Byte sizes: the app reads them as u64, this check as JavaScript numbers.
const SIZE = [1, Number.MAX_SAFE_INTEGER];
const I32 = [-(2 ** 31), 2 ** 31 - 1];
const numberOf = (value) => (value instanceof Number ? value.valueOf() : value);
const isWhole = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;
const isF32 = (value) => typeof numberOf(value) === 'number' && Number.isFinite(Math.fround(numberOf(value)));

// JSON.parse as the app reads the catalog: a whole number written as a float
// is boxed (see above), and a number JSON cannot hold (`1e400`) makes the
// whole document unreadable, as it does for serde_json.
export function parseCatalogJson(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (!Number.isFinite(value)) throw new SyntaxError(`the number ${context?.source} is out of range`);
    return Number.isInteger(value) && /[.eE]/.test(context?.source ?? '') ? new Number(value) : value;
  });
}

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
  if (entry.rank !== undefined && !isWhole(entry.rank, U32)) problems.push('rank must be a whole number from 0 to 4294967295');
  if (entry.min_ram_gb !== undefined && !(typeof numberOf(entry.min_ram_gb) === 'number' && numberOf(entry.min_ram_gb) > 0)) {
    problems.push('min_ram_gb must be a positive number');
  }
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
  problems.push(...companionProblems(entry));
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
  if (engine === 'whisper' && entry.format === OPENVINO_IR) {
    if (files.length !== OPENVINO_WHISPER_FILES.length || !OPENVINO_WHISPER_FILES.every((name) => names.has(name))) {
      problems.push(`an openvino-ir model is the files ${OPENVINO_WHISPER_FILES.join(', ')}`);
    }
  } else if (engine === 'whisper' && (files.length !== 1 || files[0].name !== `ggml-${entry.id}.bin`)) {
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

// A companion names the models it serves, the runtime that runs it and a
// pinned commit: an IR export is read only as far as the runtime understands
// it, so a new commit comes with a runtime it was measured on.
function companionProblems(entry) {
  const problems = [];
  const { companion_of: serves } = entry;
  if (entry.format === OPENVINO_IR) {
    if (!Array.isArray(serves) || serves.length === 0 || !serves.every((id) => typeof id === 'string' && ID.test(id))) {
      problems.push('companion_of must list the ids of the whisper models it serves');
    }
    if (entry.revision === undefined) problems.push('an openvino-ir model needs a pinned revision');
    if (typeof entry.runtime !== 'string' || !Object.hasOwn(RUNTIMES, entry.runtime)) {
      problems.push(`runtime must name the runtime that runs it: ${Object.keys(RUNTIMES).join(', ')}`);
    }
  } else {
    if (serves !== undefined && !(Array.isArray(serves) && serves.length === 0)) {
      problems.push('companion_of is only used by openvino-ir models');
    }
    if (entry.runtime !== undefined) problems.push('runtime is only used by openvino-ir models');
  }
  return problems;
}

// The problems of one entry of `runtimes`, as sentences: an inference runtime
// the app downloads from its vendor's archive and loads by absolute path
// (#79). `api` is the level of the runtime's API that the app's binding for
// that id calls; a build loads only a runtime of a level it knows, and the
// entry stays valid for builds of another level.
export function runtimeProblems(runtime) {
  if (!isObject(runtime)) return ['is not an object'];
  const problems = [];
  const known = typeof runtime.id === 'string' && Object.hasOwn(RUNTIMES, runtime.id) ? RUNTIMES[runtime.id] : null;
  if (!known) problems.push(`runtime ${JSON.stringify(runtime.id)} is not supported`);
  else if (!known.platforms.includes(runtime.platform)) {
    problems.push(`platform ${JSON.stringify(runtime.platform)} is not supported by ${runtime.id}`);
  }
  if (!isText(runtime.name, 80)) problems.push('name must be a non-empty text of at most 80 characters');
  if (runtime.description !== undefined && (typeof runtime.description !== 'string' || runtime.description.length > 300)) {
    problems.push('description must be a text of at most 300 characters');
  }
  if (typeof runtime.version !== 'string' || !RUNTIME_VERSION.test(runtime.version)) problems.push('version must be X.Y.Z or X.Y.Z.W');
  if (!isWhole(runtime.api, [1, U32[1]])) problems.push('api must be a whole number from 1');
  if (!isObject(runtime.license) || !isText(runtime.license.name, 80) || typeof runtime.license.url !== 'string' || !runtime.license.url.startsWith('https://')) {
    problems.push('license needs a name and an https url');
  }
  const { archive } = runtime;
  if (
    !isObject(archive) ||
    typeof archive.url !== 'string' ||
    !ZIP_URL.test(archive.url) ||
    !isWhole(archive.size, SIZE) ||
    typeof archive.sha256 !== 'string' ||
    !SHA256.test(archive.sha256)
  ) {
    problems.push('archive needs the https url of a .zip, its size and its sha256');
  } else if (known && ZIP_URL.exec(archive.url)[1].toLowerCase() !== known.host) {
    problems.push(`the archive of ${runtime.id} must come from https://${known.host}/`);
  }
  if (runtime.min_app_version !== undefined && (typeof runtime.min_app_version !== 'string' || !VERSION.test(runtime.min_app_version))) {
    problems.push('min_app_version must be X.Y.Z');
  }
  const { files } = runtime;
  if (!Array.isArray(files) || files.length === 0) return [...problems, 'files must list at least one file'];
  // Windows compares file names without case.
  const names = new Set();
  for (const file of files) {
    if (
      !isObject(file) ||
      typeof file.name !== 'string' ||
      !isRepoPath(file.path) ||
      !isWhole(file.size, SIZE) ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256)
    ) {
      problems.push('every file needs a safe name, its path in the archive, its size and its sha256');
      continue;
    }
    if (!isRuntimeFileName(file.name)) {
      problems.push(`file name ${JSON.stringify(file.name)} cannot be used: it is not one plain file name on Windows, or the install uses it`);
      continue;
    }
    if (names.has(file.name.toLowerCase())) problems.push(`file ${file.name} is listed twice`);
    names.add(file.name.toLowerCase());
  }
  const missing = (known?.files ?? []).filter((name) => !names.has(name.toLowerCase()));
  if (missing.length > 0) problems.push(`${runtime.id} needs the files ${missing.join(', ')}`);
  return problems;
}

function llamaProblems(params) {
  if (!isObject(params)) return ['params are required for llama'];
  const problems = [];
  if (!CHAT_FORMATS.includes(params.chat_format)) problems.push(`chat_format must be one of ${CHAT_FORMATS.join(', ')}`);
  if (!isWhole(params.context_size, [512, 1048576])) {
    problems.push('context_size must be a whole number from 512 to 1048576');
  }
  // llama-helper takes top_k and penalty_last_n as i32, the others as f32.
  const whole = ['top_k', 'penalty_last_n'];
  if (
    !isObject(params.sampling) ||
    !SAMPLING_FIELDS.every((field) => {
      const value = params.sampling[field];
      return whole.includes(field) ? isWhole(value, I32) : isF32(value);
    })
  ) {
    problems.push(`sampling needs the numbers ${SAMPLING_FIELDS.join(', ')} (top_k and penalty_last_n whole, the others within f32)`);
  }
  if (!Array.isArray(params.stop_tokens) || params.stop_tokens.length === 0 || !params.stop_tokens.every((token) => typeof token === 'string' && token !== '')) {
    problems.push('stop_tokens must list at least one token');
  }
  return problems;
}

// { fatal, problems: [{ list, index, id, problem }] }. `fatal` is set when
// the app could not use the document at all; otherwise each problem hides one
// entry of `list` (`models` or `runtimes`).
export function catalogProblems(document) {
  if (!isObject(document)) return { fatal: 'the catalog is not a JSON object', problems: [] };
  if (document.schema !== SCHEMA) {
    const written = document.schema instanceof Number ? `${document.schema} written as a fraction` : JSON.stringify(document.schema);
    return { fatal: `schema ${written} is not ${SCHEMA}`, problems: [] };
  }
  if (!Array.isArray(document.models)) return { fatal: 'models must be a list', problems: [] };
  const problems = [];
  const ids = new Set();
  const ggufNames = new Set();
  document.models.forEach((entry, index) => {
    const id = isObject(entry) ? entry.id : undefined;
    const own = entryProblems(entry);
    if (own.length > 0) {
      own.forEach((problem) => problems.push({ list: 'models', index, id, problem }));
      return;
    }
    // The first of two entries with the same id, or the same GGUF file name
    // (summary models share one folder), is kept.
    const key = `${entry.engine}/${entry.id}`;
    if (ids.has(key)) problems.push({ list: 'models', index, id, problem: `${key} is listed twice` });
    else if (entry.engine === 'llama' && ggufNames.has(entry.files[0].name)) {
      problems.push({ list: 'models', index, id, problem: `${entry.files[0].name} is already used by another summary model` });
    }
    ids.add(key);
    if (entry.engine === 'llama') ggufNames.add(entry.files[0].name);
  });
  // A companion must serve models the catalog has. The app does not need
  // this (a companion of an unknown model is never offered), so it is a
  // pull-request rule only.
  const ggml = new Set(
    document.models.filter((entry) => isObject(entry) && entry.engine === 'whisper' && entry.format === 'ggml').map((entry) => entry.id),
  );
  const runtimes = document.runtimes ?? [];
  const runtimeIds = new Set(Array.isArray(runtimes) ? runtimes.filter(isObject).map((runtime) => runtime.id) : []);
  document.models.forEach((entry, index) => {
    if (!isObject(entry) || entry.format !== OPENVINO_IR || !Array.isArray(entry.companion_of)) return;
    for (const id of entry.companion_of) {
      if (!ggml.has(id)) {
        problems.push({ list: 'models', index, id: entry.id, problem: `companion_of names ${id}, which is not a ggml whisper model here` });
      }
    }
    if (typeof entry.runtime === 'string' && !runtimeIds.has(entry.runtime)) {
      problems.push({ list: 'models', index, id: entry.id, problem: `runtime names ${entry.runtime}, which has no entry in runtimes` });
    }
  });
  // Apps before 0.5.0 read only `schema` and `models`. For the app a broken
  // `runtimes` list hides the runtimes, never the models.
  if (!Array.isArray(runtimes)) {
    problems.push({ list: 'runtimes', index: null, id: undefined, problem: 'runtimes must be a list' });
    return { fatal: null, problems };
  }
  const runtimeKeys = new Set();
  runtimes.forEach((runtime, index) => {
    const id = isObject(runtime) ? runtime.id : undefined;
    const own = runtimeProblems(runtime);
    if (own.length > 0) {
      own.forEach((problem) => problems.push({ list: 'runtimes', index, id, problem }));
      return;
    }
    // One entry per runtime, platform and API level: the first is kept.
    const key = `${runtime.id}/${runtime.platform}/api ${runtime.api}`;
    if (runtimeKeys.has(key)) problems.push({ list: 'runtimes', index, id, problem: `${key} is listed twice` });
    runtimeKeys.add(key);
  });
  return { fatal: null, problems };
}

function main() {
  const path = resolve(process.argv[2] ?? 'model-catalog/catalog.json');
  let document;
  try {
    document = parseCatalogJson(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exit(1);
  }
  const { fatal, problems } = catalogProblems(document);
  if (fatal) {
    console.error(`${path}: ${fatal}`);
    process.exit(1);
  }
  for (const { list, index, id, problem } of problems) console.error(`${path}: ${list}[${index ?? ''}] (${id ?? 'no id'}): ${problem}`);
  if (problems.length > 0) process.exit(1);
  const runtimes = Array.isArray(document.runtimes) ? document.runtimes.length : 0;
  console.log(`${path}: ${document.models.length} models, ${runtimes} runtimes, all valid`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
