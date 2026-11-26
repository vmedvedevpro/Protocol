import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLine, excludeJumpTables, findDisassembler, newReport, peLayout, problemsOf } from '../check-cpu-baseline.mjs';

const analyze = (lines) => {
  const report = newReport();
  for (const line of lines) analyzeLine(report, line);
  // Enough plain instructions that the listing counts as a real executable.
  for (let index = 0; index < 10_000; index += 1) analyzeLine(report, '  401000:\t48 89 c3             \tmov    %rax,%rbx');
  return report;
};

// GNU objdump -d -w on an ELF with symbols, from the 1.0.0 RC's protocol.
const gnu = [
  '000000000424ea00 <ggml_backend_cpu_device_get_extra_buffers_type>:',
  ' 424ea1d:\t62 f2 fd 08 7c c1    \tvpbroadcastq %rcx,%xmm0',
  '000000000424bab0 <ggml_cpu_fp32_to_bf16>:',
  ' 424bb10:\t62 f1 3d 48 db 14 41 \tvpandd (%rcx,%rax,2),%zmm8,%zmm2',
  '0000000004300000 <quantize_row_q8_0>:',
  ' 4300010:\t62 f1 7c 28 10 00    \tvmovups (%rax),%ymm0',
];
// llvm-objdump -d -w on a PE without symbols, from the 1.0.0 RC's protocol.exe.
const llvm = [
  '0000000140001000 <.text>:',
  '141d4f0b0: 62 f1 7e 48 5b 4c 0a ff     \tvcvttps2dq\t-0x40(%rdx,%rcx), %zmm1',
  '141f0b592: 62 f2 fd 08 40 cf           \tvpmullq\t%xmm7, %xmm0, %xmm1',
];

test('counts zmm and EVEX instructions per function in GNU objdump output', () => {
  const report = analyze(gnu);
  assert.equal(report.zmm, 1);
  assert.equal(report.evex, 3);
  assert.deepEqual([...report.evexByFunction.keys()],
    ['ggml_backend_cpu_device_get_extra_buffers_type', 'ggml_cpu_fp32_to_bf16', 'quantize_row_q8_0']);
  assert.match(problemsOf(report).join('\n'), /1 instructions use zmm/);
  assert.match(problemsOf(report, { noEvex: true }).join('\n'), /3 EVEX \(AVX-512\) instructions in 3 functions/);
});

test('reads llvm-objdump output', () => {
  const report = analyze(llvm);
  assert.equal(report.zmm, 1);
  assert.equal(report.evex, 2);
  assert.deepEqual([...report.evexByFunction], [['.text', 2]]);
});

test('EVEX on xmm fails only with --no-evex: the Windows rule tolerates MSVC dispatch', () => {
  const report = analyze([llvm[0], llvm[2]]);
  assert.deepEqual(problemsOf(report), []);
  assert.equal(problemsOf(report, { noEvex: true }).length, 1);
});

test('VEX code, address-size prefixes and undecodable bytes are not EVEX', () => {
  const report = analyze([
    ' 401100:\tc5 fc 58 c1          \tvaddps %ymm1,%ymm0,%ymm0',
    ' 401104:\tc4 e2 7d 18 05 00 00 00 00 \tvbroadcastss 0x0(%rip),%ymm0',
    ' 401110:\t67 62 f1 7c 48 10 00 \tvmovups (%eax),%zmm0',
    ' 401120:\t62 11 00 cf 64       \t(bad)',
  ]);
  assert.equal(report.evex, 1, 'only the 67-prefixed vmovups');
  assert.equal(report.zmm, 1);
});

test('a listing without code fails instead of passing', () => {
  const report = newReport();
  analyzeLine(report, 'protocol.exe:\tfile format coff-x86-64');
  assert.match(problemsOf(report).join('\n'), /only 0 instructions/);
});

test('OBJDUMP that does not run is reported', () => {
  assert.throws(() => findDisassembler({ OBJDUMP: '/nonexistent/objdump' }, 'linux'), /set OBJDUMP/);
});

// A PE32+ file with one code section, .text at RVA 0x1000 (file offset 0x200),
// holding a real AVX-512 instruction at 0x1000 and, at 0x1010, a switch's
// jump table of RVAs into .text, as MSVC lays them out.
function peWithJumpTable() {
  const buffer = Buffer.alloc(0x400);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write('PE\0\0', 0x40, 'latin1');
  buffer.writeUInt16LE(0x8664, 0x44);
  buffer.writeUInt16LE(1, 0x46);
  buffer.writeUInt16LE(0xf0, 0x54);
  const optional = 0x58;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeBigUInt64LE(0x140000000n, optional + 24);
  const section = optional + 0xf0;
  buffer.write('.text', section, 'latin1');
  buffer.writeUInt32LE(0x100, section + 8);
  buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0x100, section + 16);
  buffer.writeUInt32LE(0x200, section + 20);
  buffer.writeUInt32LE(0x60000020, section + 36);
  Buffer.from([0x62, 0xf1, 0x7c, 0x48, 0x10, 0x00]).copy(buffer, 0x200);
  [0x1040, 0x1062, 0x1070, 0x1080].forEach((rva, index) => buffer.writeUInt32LE(rva, 0x210 + index * 4));
  return buffer;
}

const tableLines = [
  '0000000140001000 <.text>:',
  '140001000: 62 f1 7c 48 10 00           \tvmovups\t(%rax), %zmm0',
  // The bytes from 0x140001015 on, read as code (rc.1's failure, #216).
  '140001015: 62 ea 01 c3 65 ea 01 00     \tvblendmps\t%zmm18, %zmm15, %zmm21 {%k3} {z}',
];

test('PE layout: image base and executable sections', () => {
  assert.deepEqual(peLayout(peWithJumpTable()), { imageBase: 0x140000000n, sections: [{ rva: 0x1000, size: 0x100, file: 0x200 }] });
  assert.equal(peLayout(Buffer.from('\x7fELF')), null);
});

test('a decode inside a jump table of RVAs is not counted; real AVX-512 next to it is', () => {
  const report = excludeJumpTables(analyze(tableLines), peWithJumpTable());
  assert.equal(report.zmm, 1);
  assert.equal(report.evex, 1);
  assert.equal(report.jumpTable, 1);
  assert.match(report.jumpTableSamples[0], /^140001015: vblendmps/);
  assert.match(problemsOf(report).join('\n'), /1 instructions use zmm[^]*140001000: vmovups/);
});

test('jump-table data alone passes', () => {
  const report = excludeJumpTables(analyze([tableLines[0], tableLines[2]]), peWithJumpTable());
  assert.deepEqual(problemsOf(report, { noEvex: true }), []);
  assert.deepEqual([...report.evexByFunction], []);
});

test('a dword that is an RVA without a neighbouring one is code, not a table', () => {
  const buffer = peWithJumpTable();
  buffer.fill(0xcc, 0x210, 0x220);
  buffer.writeUInt32LE(0x1062, 0x214);
  const report = excludeJumpTables(analyze(tableLines), buffer);
  assert.equal(report.zmm, 2);
  assert.equal(report.jumpTable, 0);
});

test('outside a PE file (ELF) nothing is taken out', () => {
  const report = excludeJumpTables(analyze(tableLines), Buffer.from('\x7fELF and more'));
  assert.equal(report.zmm, 2);
});

test('EVEX on xmm is never taken for table data: its P2 can be 0, like an RVA', () => {
  const buffer = peWithJumpTable();
  const lines = [tableLines[0], '140001014: 62 01 3c 00 57 c0           \tvxorps\t%xmm24, %xmm24, %xmm24'];
  const report = excludeJumpTables(analyze(lines), buffer);
  assert.equal(report.evex, 1);
  assert.equal(report.jumpTable, 0);
});
