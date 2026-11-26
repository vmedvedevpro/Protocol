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
//
// Data in code (#216). MSVC puts a switch's jump table, 32-bit RVAs of its
// cases, into .text next to the function, and a disassembler decodes it as
// instructions; GCC puts them in .rodata. 1.0.0's protocol-vulkan.exe has
// 1557 undecodable spots there. In 1.0.0-rc.1 a table entry 0x01ea62xx put
// the bytes 62 ea 01 in a row: a valid EVEX prefix (map 0F38, pp 66, vvvv 15,
// R' 0) whose last byte, the next entry's low byte, chose zmm and {k3}{z},
// so the table read as "vblendmps %zmm18,%zmm15,%zmm21{%k3}{z}" and failed
// the release, though the code was the same as 1.0.0's: only the version
// string had moved the layout. So in a PE file a zmm decode that starts
// inside such a table is not counted: the aligned dword it starts in, and one
// beside it, are both RVAs inside an executable section. A real zmm
// instruction does not look like that. Its EVEX prefix is 62 P0 P1 P2 with
// L'L = 10 in P2, so P2 >= 0x40; an RVA's top byte is 0 to 2 in these
// 35 MB executables. Starting on the dword boundary puts P2 in the top
// byte, starting one byte in puts P1 there (bit 2 set, so >= 0x04), three
// bytes in puts 62 there; only two bytes in, with P0 <= 2 (R, X, B and R' all
// extended registers) and an RVA-like dword beside it, could a real one be
// skipped, and an AVX-512 ggml has thousands (4780 in the 1.0.0 RC's
// protocol.exe, of which this rule skips none). EVEX on xmm is not skipped:
// there P2 can be 0 (vxorps %xmm24,%xmm24,%xmm24 is 62 01 3c 00 57 c0),
// which does look like an RVA. The rule reads only the file, keeps the whole
// file checked (Rust and C++ alike, without symbols), and lists what it
// skipped.
// zlib-rs, which the Windows tree has through ffmpeg-sidecar's zip, was the
// first suspect and is not it: its AVX-512 code is behind its "avx512"
// feature and cfg!(target_feature), and the tree does not enable either.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  return {
    instructions: 0, zmm: 0, evex: 0, zmmSamples: [], evexByFunction: new Map(), function: null,
    // Every zmm or EVEX decode, so that decodes of data can be taken out later.
    flagged: [], jumpTable: 0, jumpTableSamples: [],
  };
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
  const name = report.function ?? '?';
  const zmm = ZMM.test(text);
  if (zmm) {
    report.zmm += 1;
    if (report.zmmSamples.length < 10) report.zmmSamples.push(`${address}: ${text.trim()} (${name})`);
  }
  const bytes = hex.trim().split(' ');
  let index = 0;
  while (index < bytes.length && EVEX_PREFIXES.has(bytes[index])) index += 1;
  // 62 is EVEX in 64-bit code (BOUND does not exist there). An EVEX
  // instruction has the 4-byte prefix, an opcode and a ModRM byte at least;
  // shorter runs are bytes the disassembler could not decode.
  const evex = bytes[index] === '62' && bytes.length - index >= 6 && !text.startsWith('(bad)');
  if (evex) {
    report.evex += 1;
    report.evexByFunction.set(name, (report.evexByFunction.get(name) ?? 0) + 1);
  }
  if (zmm || evex) report.flagged.push({ address: BigInt(`0x${address}`), text: text.trim(), function: name, zmm, evex });
}

// The image base and the executable sections of a PE32+ file, or null when
// the buffer is not one (an ELF needs none of this: see the header).
export function peLayout(buffer) {
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') return null;
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 > buffer.length || buffer.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
  const count = buffer.readUInt16LE(pe + 6);
  const optional = pe + 24;
  if (buffer.readUInt16LE(optional) !== 0x20b) return null;
  const imageBase = buffer.readBigUInt64LE(optional + 24);
  const table = optional + buffer.readUInt16LE(pe + 20);
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const header = table + index * 40;
    const characteristics = buffer.readUInt32LE(header + 36);
    // IMAGE_SCN_CNT_CODE or IMAGE_SCN_MEM_EXECUTE.
    if (!(characteristics & 0x20) && !(characteristics & 0x20000000)) continue;
    sections.push({
      rva: buffer.readUInt32LE(header + 12),
      size: Math.min(buffer.readUInt32LE(header + 8), buffer.readUInt32LE(header + 16)),
      file: buffer.readUInt32LE(header + 20),
    });
  }
  return { imageBase, sections };
}

// Whether the decode at `address` starts inside a jump table of RVAs.
export function inJumpTable(buffer, layout, address) {
  const rva = Number(address - layout.imageBase);
  const section = layout.sections.find(({ rva: start, size }) => rva >= start && rva < start + size);
  if (!section) return false;
  const isCodeRva = (value) => layout.sections.some(({ rva: start, size }) => value >= start && value < start + size);
  const entry = (offset) => {
    if (offset < section.rva || offset + 4 > section.rva + section.size) return null;
    return buffer.readUInt32LE(section.file + offset - section.rva);
  };
  const aligned = rva & ~3;
  if (!isCodeRva(entry(aligned))) return false;
  return [aligned - 4, aligned + 4].some((offset) => isCodeRva(entry(offset)));
}

// Takes the zmm decodes of jump-table data out of the counts (see the header).
export function excludeJumpTables(report, buffer) {
  const layout = peLayout(buffer);
  if (!layout) return report;
  const kept = [];
  for (const instruction of report.flagged) {
    if (!instruction.zmm || !inJumpTable(buffer, layout, instruction.address)) {
      kept.push(instruction);
      continue;
    }
    report.jumpTable += 1;
    if (report.jumpTableSamples.length < 10) {
      report.jumpTableSamples.push(`${instruction.address.toString(16)}: ${instruction.text}`);
    }
    if (instruction.zmm) report.zmm -= 1;
    if (instruction.evex) {
      report.evex -= 1;
      const left = report.evexByFunction.get(instruction.function) - 1;
      if (left > 0) report.evexByFunction.set(instruction.function, left);
      else report.evexByFunction.delete(instruction.function);
    }
  }
  report.flagged = kept;
  const samples = kept.filter(({ zmm }) => zmm).slice(0, 10);
  report.zmmSamples = samples.map(({ address, text, function: name }) => `${address.toString(16)}: ${text} (${name})`);
  return report;
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
  if (code === 0) excludeJumpTables(report, await readFile(path));
  const problems = code === 0 ? problemsOf(report, { noEvex }) : [`${disassembler} exited with ${code}: ${stderr.trim()}`];
  return { path, report, problems };
}

// Without symbols (Windows) every instruction counts towards one section
// label, so the per-function list only helps where symbols exist.
function summary({ path, report }) {
  let line = `${path}: ${report.instructions} instructions, ${report.zmm} on zmm, ${report.evex} EVEX`;
  if (report.evex > 0) line += ` (${topFunctions(report).join(', ')})`;
  if (report.jumpTable > 0) line += `\n  not counted, jump-table data read as code: ${report.jumpTableSamples.join('; ')}`;
  return line;
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
