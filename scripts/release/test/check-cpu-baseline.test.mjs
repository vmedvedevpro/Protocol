import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeLine, findDisassembler, newReport, problemsOf } from '../check-cpu-baseline.mjs';

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
