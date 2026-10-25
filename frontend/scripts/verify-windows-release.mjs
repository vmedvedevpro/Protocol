import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const dist = resolve(process.argv[2] || join(repo, 'dist'));
const config = JSON.parse(await readFile(join(repo, 'frontend/src-tauri/tauri.conf.json'), 'utf8'));
const version = config.version;
const engine = `Protocol-${version}-x64-universal-engine.exe`;
const setup = `Protocol-${version}-x64-universal-setup.exe`;

async function hash(path, algorithm = 'sha256') {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest();
}

const sums = (await readFile(join(dist, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
assert.equal(sums.length, 2);
const names = [];
for (const line of sums) {
  const [, expected, name] = line.match(/^([a-f0-9]{64})  (.+)$/) || [];
  assert.ok(name && name === basename(name), 'Invalid checksum entry');
  assert.equal((await hash(join(dist, name))).toString('hex'), expected, name);
  names.push(name);
}
assert.deepEqual(names.sort(), [setup, engine].sort());
console.log('Release checksums verified.');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 600_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
const sevenZip = process.env.SEVEN_ZIP || 'C:\\Program Files\\7-Zip\\7z.exe';
run(sevenZip, ['t', join(dist, engine)]);
const extracted = await mkdtemp(join(dist, 'verify-'));
try {
  run(sevenZip, ['x', join(dist, engine), `-o${extracted}`, '-y', 'installer-variants/*', 'ffmpeg.exe', 'llama-helper.exe', 'resources/*', 'runtime-deps/*', 'binaries/onnxruntime/*']);
  for (const name of ['meetily-cpu.exe', 'meetily-vulkan.exe', 'meetily-cuda.exe', 'meetily-vulkan-probe.exe']) {
    assert.deepEqual(await hash(join(extracted, 'installer-variants', name)),
      await hash(join(repo, 'frontend/src-tauri/installer-variants', name)), `Stale packaged variant: ${name}`);
  }
  assert.deepEqual(await hash(join(extracted, 'ffmpeg.exe')),
    await hash(join(repo, 'frontend/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe')));
  for (const name of ['parakeet-rs-LICENSE.txt', 'THIRD_PARTY_MODELS.txt']) {
    assert.deepEqual(await hash(join(extracted, 'resources/diarization', name)),
      await hash(join(repo, 'frontend/src-tauri/resources/diarization', name)), `Missing or stale notice: ${name}`);
  }
  for (const name of ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime-LICENSE.txt', 'DirectML.dll', 'DirectML-LICENSE.txt']) {
    assert.deepEqual(await hash(join(extracted, 'binaries/onnxruntime', name)),
      await hash(join(repo, 'frontend/src-tauri/binaries/onnxruntime', name)), `Unexpected ONNX Runtime: ${name}`);
  }
} finally {
  await rm(extracted, { recursive: true, force: true });
}
run(join(dist, setup), ['--verify-payload']);
console.log(`Windows ${version} release payload verified without installing.`);
