// Checks the output of build-universal-windows.ps1 without installing it:
//   node frontend/scripts/verify-windows-release.mjs [dist-dir]
// SHA256SUMS.txt matches protocol-windows-x64-setup.exe, and the installer's
// payload (extracted with 7-Zip; SEVEN_ZIP overrides its path) carries the CPU
// build as protocol.exe, the Vulkan build and probe as variants, no CUDA
// files, the pinned runtimes and sidecars, and the "nsis" bundle-type marker
// on both executables that can end up installed as protocol.exe.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hasBundleType } from '../../scripts/release/patch-bundle-type.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const tauri = join(repo, 'frontend/src-tauri');
const dist = resolve(process.argv[2] || join(repo, 'dist'));
const config = JSON.parse(await readFile(join(tauri, 'tauri.conf.json'), 'utf8'));
const version = config.version;
const setup = 'protocol-windows-x64-setup.exe';

async function hash(path, algorithm = 'sha256') {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest();
}

// Names of the DLLs in a PE32+ executable's import table. Delay-loaded DLLs
// are listed elsewhere and not returned.
function importedDlls(buffer) {
  const pe = buffer.readUInt32LE(0x3c);
  assert.equal(buffer.toString('latin1', pe, pe + 4), 'PE\0\0', 'not a PE file');
  const sections = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24;
  assert.equal(buffer.readUInt16LE(optional), 0x20b, 'not a PE32+ executable');
  const importRva = buffer.readUInt32LE(optional + 112 + 8);
  const sectionTable = optional + optionalSize;
  const offsetOf = (rva) => {
    for (let index = 0; index < sections; index += 1) {
      const header = sectionTable + index * 40;
      const virtualSize = buffer.readUInt32LE(header + 8);
      const virtualAddress = buffer.readUInt32LE(header + 12);
      const rawSize = buffer.readUInt32LE(header + 16);
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
        return rva - virtualAddress + buffer.readUInt32LE(header + 20);
      }
    }
    throw new Error(`RVA ${rva} is outside every section`);
  };
  const names = [];
  for (let descriptor = offsetOf(importRva); ; descriptor += 20) {
    const nameRva = buffer.readUInt32LE(descriptor + 12);
    if (nameRva === 0) break;
    const start = offsetOf(nameRva);
    names.push(buffer.toString('latin1', start, buffer.indexOf(0, start)).toLowerCase());
  }
  return names;
}

const sums = (await readFile(join(dist, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/);
const names = [];
for (const line of sums) {
  const [, expected, name] = line.match(/^([a-f0-9]{64}) {2}(.+)$/) || [];
  assert.ok(name && name === basename(name), `Invalid checksum entry: ${line}`);
  assert.equal((await hash(join(dist, name))).toString('hex'), expected, name);
  names.push(name);
}
assert.deepEqual(names, [setup]);
console.log('Release checksums verified.');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 600_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
const sevenZip = process.env.SEVEN_ZIP
  || ['C:\\Program Files\\7-Zip\\7z.exe', join(repo, '.build-tools/7zip/7z.exe')].find(existsSync)
  || '7z';
run(sevenZip, ['t', join(dist, setup)]);
const extracted = await mkdtemp(join(dist, 'verify-'));
try {
  run(sevenZip, ['x', join(dist, setup), `-o${extracted}`, '-y', 'protocol.exe', 'installer-variants/*', 'ffmpeg.exe',
    'llama-helper.exe', 'resources/*', 'runtime-deps/*', 'binaries/onnxruntime/*']);
  const sameAs = async (packaged, staged, message) =>
    assert.deepEqual(await hash(join(extracted, packaged)), await hash(join(tauri, staged)), message);

  const listed = async (dir) => (await readdir(join(extracted, dir))).filter((name) => name !== '.gitkeep').sort();
  assert.deepEqual(await listed('installer-variants'), ['protocol-vulkan-probe.exe', 'protocol-vulkan.exe', 'universal.marker'],
    'Unexpected installer variants');
  for (const name of ['protocol-vulkan.exe', 'protocol-vulkan-probe.exe']) {
    await sameAs(`installer-variants/${name}`, `installer-variants/${name}`, `Stale packaged variant: ${name}`);
  }

  // The bundled CPU build must start without a Vulkan loader; the Vulkan build
  // imports it at load time (whisper.cpp links ggml-vulkan statically).
  const cpu = await readFile(join(extracted, 'protocol.exe'));
  const vulkan = await readFile(join(extracted, 'installer-variants/protocol-vulkan.exe'));
  assert.ok(!importedDlls(cpu).includes('vulkan-1.dll'), 'The bundled protocol.exe is not the CPU build');
  assert.ok(importedDlls(vulkan).includes('vulkan-1.dll'), 'protocol-vulkan.exe is not the Vulkan build');
  for (const [name, buffer] of [['protocol.exe', cpu], ['protocol-vulkan.exe', vulkan]]) {
    assert.ok(hasBundleType(buffer, 'nsis'), `${name} lacks the nsis bundle-type marker the updater needs`);
  }

  assert.deepEqual(await listed('runtime-deps'), ['DirectML.dll', 'vc_redist.x64.exe'], 'Unexpected runtime-deps');
  await sameAs('runtime-deps/DirectML.dll', 'binaries/onnxruntime/DirectML.dll', 'Unexpected DirectML.dll');
  await sameAs('runtime-deps/vc_redist.x64.exe', 'runtime-deps/vc_redist.x64.exe', 'Stale VC++ redistributable');

  await sameAs('ffmpeg.exe', 'binaries/ffmpeg-x86_64-pc-windows-msvc.exe', 'Stale ffmpeg.exe');
  await sameAs('llama-helper.exe', 'binaries/llama-helper-x86_64-pc-windows-msvc.exe', 'Stale llama-helper.exe');
  // The diarization models and their notices; the files Protocol 0.3.0
  // bundled under other names must not come back (installer-hooks.nsh
  // deletes them from an updated install).
  const diarization = ['THIRD_PARTY_MODELS.txt', 'parakeet-rs-LICENSE.txt', 'segmentation-3.0.onnx',
    'voxceleb_resnet34_LM.onnx', 'xvec_transform.npz'];
  assert.deepEqual(await listed('resources/diarization'), diarization, 'Unexpected diarization resources');
  for (const name of diarization) {
    await sameAs(`resources/diarization/${name}`, `resources/diarization/${name}`, `Missing or stale: ${name}`);
  }
  for (const name of ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime-LICENSE.txt', 'DirectML.dll', 'DirectML-LICENSE.txt']) {
    await sameAs(`binaries/onnxruntime/${name}`, `binaries/onnxruntime/${name}`, `Unexpected ONNX Runtime: ${name}`);
  }
} finally {
  await rm(extracted, { recursive: true, force: true });
}
console.log(`Windows ${version} installer payload verified without installing.`);
