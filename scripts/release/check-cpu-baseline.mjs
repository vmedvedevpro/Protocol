#!/usr/bin/env node
// Fails when a shipped x86_64 executable uses AVX-512 (#176). The release
// legs build ggml for x86-64-v3 (GGML_NATIVE=OFF, AVX2, FMA, F16C, BMI2), not
// for the runner's CPU; a runner with AVX-512 once put AVX-512 into ggml's CPU
// backend, and Whisper died with SIGILL at every model load on CPUs without it.
// Nothing in the build pins the runner's CPU, so this check is what notices
// a build that compiles for it again.
//
//   node scripts/release/check-cpu-baseline.mjs [--no-evex] <executable>...
//
// The executable is disassembled (OBJDUMP, else llvm-objdump or GNU objdump)
// and fails the check when:
// - any instruction uses a zmm register. ggml's AVX-512 paths work on 512-bit
//   vectors, so an AVX-512 ggml always has zmm code (MSVC's /arch:AVX512 as
//   much as GCC's -mavx512f); nothing else in these executables does today.
// - with --no-evex (Linux): any instruction is EVEX-encoded, the AVX-512
//   encoding that also serves xmm and ymm registers. The Linux executables
//   have none outside ggml, and inside ggml not every function carries "ggml"
//   in its name (quantize_row_q8_0, gemm_q4_b32_8x8_q8_0_lut_avx), so the
//   whole file is checked.
// Windows is checked for zmm only: there the MSVC auto-vectorizer adds a few
// xmm-only AVX-512VL loops (vpmullq, vpminuq) to C code, each behind a runtime
// check of the CRT's __isa_available (6 = AVX-512), so CPUs without AVX-512
// never run them; protocol-mcp.exe, which has no ggml, has them too.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const ZMM = /\bzmm(?:[12]?[0-9]|3[01])\b/;
const SYMBOL = /^[0-9a-f]+ <(.+)>:$/;
// GNU objdump -w: "  1000:\t62 f1 7c 48 10 00 \tvmovups ..."; llvm-objdump:
// "1000: 62 f1 7c 48 10 00   \tvmovups ...". Bytes are lower-case hex pairs.
const INSTRUCTION = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2} )+)\s*(.*)$/;
// Address-size and segment prefixes may precede EVEX; 66/F2/F3/REX may not.
const EVEX_PREFIXES = new Set(['67', '26', '2e', '36', '3e', '64', '65']);
// Below this, the disassembler produced no real listing of an executable.
const MIN_INSTRUCTIONS = 10_000;

export function newReport() {
  return { instructions: 0, zmm: 0, evex: 0, zmmSamples: [], evexByFunction: new Map(), function: null };
}

// Feeds one line of objdump -d output into the report.
export function analyzeLine(report, line) {
  const symbol = SYMBOL.exec(line);
  if (symbol) {
    report.function = symbol[1];
    return;
  }
  const match = INSTRUCTION.exec(line);
  if (!match) return;
  const [, address, hex, text] = match;
  report.instructions += 1;
  if (ZMM.test(text)) {
    report.zmm += 1;
    if (report.zmmSamples.length < 10) report.zmmSamples.push(`${address}: ${text.trim()} (${report.function ?? '?'})`);
  }
  const bytes = hex.trim().split(' ');
  let index = 0;
  while (index < bytes.length && EVEX_PREFIXES.has(bytes[index])) index += 1;
  // 62 is EVEX in 64-bit code (BOUND does not exist there). An EVEX
  // instruction has the 4-byte prefix, an opcode and a ModRM byte at least;
  // shorter runs are bytes the disassembler could not decode.
  if (bytes[index] === '62' && bytes.length - index >= 6 && !text.startsWith('(bad)')) {
    report.evex += 1;
    const name = report.function ?? '?';
    report.evexByFunction.set(name, (report.evexByFunction.get(name) ?? 0) + 1);
  }
}

export function problemsOf(report, { noEvex = false } = {}) {
  const problems = [];
  if (report.instructions < MIN_INSTRUCTIONS) {
    problems.push(`only ${report.instructions} instructions disassembled: not an x86_64 executable, or the disassembler failed`);
  }
  if (report.zmm > 0) {
    problems.push(`${report.zmm} instructions use zmm registers (AVX-512), e.g.\n    ${report.zmmSamples.join('\n    ')}`);
  }
  if (noEvex && report.evex > 0) {
    problems.push(`${report.evex} EVEX (AVX-512) instructions in ${report.evexByFunction.size} functions, e.g. ${topFunctions(report).join(', ')}`);
  }
  return problems;
}

export function findDisassembler(env = process.env, platform = process.platform) {
  const candidates = env.OBJDUMP
    ? [env.OBJDUMP]
    : platform === 'win32'
      // The windows-2022 runner image installs LLVM there; Strawberry Perl
      // brings GNU binutils.
      ? ['C:\\Program Files\\LLVM\\bin\\llvm-objdump.exe', 'llvm-objdump', 'objdump', 'C:\\Strawberry\\c\\bin\\objdump.exe']
      : ['objdump', 'llvm-objdump'];
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error(`no disassembler found (tried ${candidates.join(', ')}); set OBJDUMP to llvm-objdump or GNU objdump`);
}

function topFunctions(report, count = 5) {
  return [...report.evexByFunction].sort((a, b) => b[1] - a[1]).slice(0, count).map(([name, n]) => `${name} ${n}`);
}

export async function checkExecutable(path, { noEvex = false, disassembler = findDisassembler() } = {}) {
  const report = newReport();
  const child = spawn(disassembler, ['-d', '-w', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((done, fail) => {
    child.on('error', fail);
    child.on('close', (code) => done(code));
  });
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) analyzeLine(report, line);
  const code = await exited;
  const problems = code === 0 ? problemsOf(report, { noEvex }) : [`${disassembler} exited with ${code}: ${stderr.trim()}`];
  return { path, report, problems };
}

// Without symbols (Windows) every instruction counts towards one section
// label, so the per-function list only helps where symbols exist.
function summary({ path, report }) {
  const line = `${path}: ${report.instructions} instructions, ${report.zmm} on zmm, ${report.evex} EVEX`;
  return report.evex > 0 ? `${line} (${topFunctions(report).join(', ')})` : line;
}

async function main(argv) {
  const noEvex = argv.includes('--no-evex');
  const paths = argv.filter((arg) => arg !== '--no-evex').map((path) => resolve(path));
  if (paths.length === 0) throw new Error('usage: check-cpu-baseline.mjs [--no-evex] <executable>...');
  const disassembler = findDisassembler();
  console.log(`Disassembling with ${disassembler}`);
  const results = await Promise.all(paths.map((path) => checkExecutable(path, { noEvex, disassembler })));
  let failed = false;
  for (const result of results) {
    console.log(summary(result));
    for (const problem of result.problems) {
      console.error(`  ${problem}`);
      failed = true;
    }
  }
  if (failed) {
    console.error('An executable is not built for the x86-64-v3 baseline (GGML_* in the release legs, #176).');
    process.exit(1);
  }
  console.log('No AVX-512 in ggml: the executables run on every CPU with AVX2.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
