import { expect, test } from 'bun:test';
import {
  NPU_ABSENT,
  deviceOf,
  gpuFallback,
  gpuVersionLabel,
  gpuVersionStandIn,
  npuNote,
  npuOwnsParakeet,
  offerFor,
  parakeetLine,
  recommendedPair,
  sumBytes,
  type ParakeetNpuStatus,
  type WhisperListed,
} from '../../src/lib/speech-choice';
import { intelError, type CompanionStatus, type OpenVinoAvailability } from '../../src/lib/intel-gpu';

const MB = 1024 * 1024;
const GPU_ID = 'large-v3-turbo-openvino-int8';
const COPY = 'large-v3-turbo-q5_0';
const PARAKEET = 'parakeet-tdt-0.6b-v3-int8';

const intelGpu: OpenVinoAvailability = { offer: true, gpu: 'Intel(R) Arc(TM) B390 GPU', reason: null, device: null, mismatch: null };
const otherGpu: OpenVinoAvailability = { offer: false, gpu: 'NVIDIA GeForce RTX 4060', reason: 'not an Intel GPU', device: null, mismatch: null };
const npu = (state: ParakeetNpuStatus['state'], extra: Partial<ParakeetNpuStatus> = {}): ParakeetNpuStatus =>
  ({ present: state !== 'absent', state, active: state === 'ready', reason: state === 'failed' ? 'compile failed' : null, ...extra });

function companion(extra: Partial<CompanionStatus> = {}): CompanionStatus {
  return {
    id: GPU_ID,
    name: 'Large V3 Turbo for Intel GPUs',
    description: '',
    repo: 'OpenVINO/whisper-large-v3-turbo-int8-ov',
    companionOf: ['large-v3-turbo', COPY],
    size: 828 * MB,
    companionInstalled: false,
    runtime: {
      name: 'OpenVINO GenAI', version: '2026.4.1.0', license: { name: 'Intel', url: 'https://intel.example' },
      source: 'storage.openvinotoolkit.org', downloadSize: 254 * MB, installedSize: 111 * MB,
      installed: null, afterRestart: null, removedAtRestart: null,
    },
    installed: false,
    downloadSize: (254 + 828) * MB,
    refused: null,
    downloading: null,
    progress: null,
    stopped: null,
    removesRuntime: true,
    ...extra,
  };
}

const whisper: WhisperListed[] = [
  { name: 'small', size_bytes: 1, status: 'Available' },
  { name: COPY, size_bytes: 547 * MB, status: 'Available', recommended: true },
  { name: GPU_ID, size_bytes: 828 * MB, status: 'Missing', companion_of: ['large-v3-turbo', COPY], display_name: 'Large V3 Turbo' },
];
const parakeet = [{ name: PARAKEET, size_bytes: 640 * MB, status: 'Available' as const, recommended: true }];

test('an Intel GPU and NPU get Parakeet on the NPU and the Intel GPU version of Whisper', () => {
  const pair = recommendedPair({ whisper, parakeet, availability: intelGpu, companion: companion(), npu: npu('needs_runtime') });
  expect(pair).toEqual({
    live: { id: PARAKEET, device: 'Intel NPU' },
    after: { id: GPU_ID, gpu: true, device: 'Intel GPU' },
    copy: COPY,
  });
});

test('an Intel GPU without an NPU, and an NPU without an Intel GPU, each get their own badge only', () => {
  const gpuOnly = recommendedPair({ whisper, parakeet, availability: intelGpu, companion: companion(), npu: NPU_ABSENT });
  expect(gpuOnly.live.device).toBeNull();
  expect(gpuOnly.after).toEqual({ id: GPU_ID, gpu: true, device: 'Intel GPU' });
  const npuOnly = recommendedPair({ whisper, parakeet, availability: otherGpu, companion: companion(), npu: npu('needs_model') });
  expect(npuOnly.live.device).toBe('Intel NPU');
  expect(npuOnly.after).toEqual({ id: COPY, gpu: false, device: null });
});

test('another computer gets Parakeet and the Compressed copy without badges', () => {
  for (const availability of [otherGpu, null]) {
    const pair = recommendedPair({ whisper, parakeet, availability, companion: companion(), npu: NPU_ABSENT });
    expect(pair.live).toEqual({ id: PARAKEET, device: null });
    expect(pair.after).toEqual({ id: COPY, gpu: false, device: null });
  }
  // An Intel GPU this build cannot install Intel's libraries for is no Intel GPU here.
  const refused = recommendedPair({ whisper, parakeet, availability: intelGpu, companion: companion({ refused: 'too old' }), npu: NPU_ABSENT });
  expect(refused.after.gpu).toBe(false);
});

test('the pair follows the catalog: its recommended models, and the defaults without one', () => {
  const pair = recommendedPair({
    whisper: [{ name: 'medium-q5_0', size_bytes: 1, status: 'Missing', recommended: true }, { ...whisper[2], recommended: true }],
    parakeet: [{ name: 'parakeet-next', size_bytes: 1, status: 'Missing', recommended: true }],
    availability: null, companion: null, npu: npu('ready'),
  });
  // The Intel GPU version is never the regular copy, and only Parakeet v3 runs on the NPU.
  expect(pair.copy).toBe('medium-q5_0');
  expect(pair.live).toEqual({ id: 'parakeet-next', device: null });
  const fallback = recommendedPair({ whisper: [], parakeet: [], availability: null, companion: null, npu: NPU_ABSENT });
  expect([fallback.live.id, fallback.copy]).toEqual([PARAKEET, COPY]);
});

test('the selects badge the device each installed model runs on', () => {
  const installedGpu = { ...whisper[2], status: 'Available' as const };
  const running = { npu: npu('ready'), gpuVersion: installedGpu, gpuFallback: null };
  expect(deviceOf('whisper', GPU_ID, running)).toBe('Intel GPU');
  // A ggml model the Intel GPU version runs in place of (#79) runs there too.
  expect(deviceOf('whisper', COPY, running)).toBe('Intel GPU');
  expect(deviceOf('whisper', 'small', running)).toBeNull();
  // The full model it is named after would read the same as it: only it has the badge.
  expect(deviceOf('whisper', 'large-v3-turbo', running)).toBeNull();
  expect(deviceOf('parakeet', PARAKEET, running)).toBe('Intel NPU');
  expect(deviceOf('parakeet', 'parakeet-tdt-0.6b-v2-int8', running)).toBeNull();

  // Fallen back, not installed, or the NPU not ready yet: no badge.
  expect(deviceOf('whisper', GPU_ID, { ...running, gpuFallback: 'compile failed' })).toBeNull();
  expect(deviceOf('whisper', COPY, { ...running, gpuVersion: whisper[2] })).toBeNull();
  for (const state of ['preparing', 'waiting', 'failed', 'needs_runtime'] as const) {
    expect(deviceOf('parakeet', PARAKEET, { ...running, npu: npu(state, { active: false }) })).toBeNull();
  }
});

test('the Intel GPU version counts as fallen back after a crash, a failed load or a GPU it cannot use', () => {
  const installed = companion({ installed: true, companionInstalled: true });
  expect(gpuFallback(installed, null, intelGpu)).toBeNull();
  expect(gpuFallback(installed, 'compile failed', intelGpu)).toBe('compile failed');
  expect(gpuFallback({ ...installed, stopped: 'Protocol closed unexpectedly' }, null, intelGpu)).toBe('Protocol closed unexpectedly');
  expect(gpuFallback(installed, null, { ...intelGpu, mismatch: 'no such GPU' })).toBe('no such GPU');
  // Not installed: nothing to fall back from.
  expect(gpuFallback(companion(), 'compile failed', intelGpu)).toBeNull();
});

test('the offer after an update names the devices it would use, with the size of what Switch downloads', () => {
  const both = offerFor({ installedAny: true, availability: intelGpu, companion: companion(), npu: npu('needs_runtime'), dismissed: [] });
  expect(both).toMatchObject({ devices: ['Intel GPU', 'Intel NPU'], title: 'Protocol can use your Intel GPU and NPU', gpu: true, bytes: (254 + 828) * MB });
  expect(both!.description).toContain('Whisper switches to its Intel GPU version');
  const gpuOnly = offerFor({ installedAny: true, availability: intelGpu, companion: companion(), npu: NPU_ABSENT, dismissed: [] });
  expect(gpuOnly).toMatchObject({ devices: ['Intel GPU'], title: 'Protocol can use your Intel GPU', gpu: true });
  const npuOnly = offerFor({ installedAny: true, availability: otherGpu, companion: companion(), npu: npu('needs_runtime'), dismissed: [] });
  expect(npuOnly).toMatchObject({ devices: ['Intel NPU'], title: 'Protocol can use your Intel NPU', gpu: false, bytes: 254 * MB });
});

test('the offer shows only after an update, and only for what is missing', () => {
  const base = { installedAny: true, availability: intelGpu, companion: companion(), npu: npu('needs_runtime'), dismissed: [] };
  // A first run gets the For this computer card instead.
  expect(offerFor({ ...base, installedAny: false })).toBeNull();
  // The Intel GPU version installed, and the NPU has its libraries (or is past them).
  for (const state of ['needs_model', 'waiting', 'preparing', 'ready', 'failed'] as const) {
    expect(offerFor({ ...base, companion: companion({ installed: true }), npu: npu(state) })).toBeNull();
  }
  // A download that runs is shown in the card.
  expect(offerFor({ ...base, companion: companion({ downloading: 40 }), npu: NPU_ABSENT })).toBeNull();
  expect(offerFor({ ...base, availability: otherGpu, librariesDownloading: true })).toBeNull();
  // Neither device.
  expect(offerFor({ ...base, availability: otherGpu, npu: NPU_ABSENT })).toBeNull();
});

test('Not now hides the offer until it can offer a device it did not offer then', () => {
  const base = { installedAny: true, availability: intelGpu, companion: companion(), npu: NPU_ABSENT };
  expect(offerFor({ ...base, dismissed: ['Intel GPU'] })).toBeNull();
  // The NPU becomes usable later (#66 in an update): the offer is back, for both.
  const back = offerFor({ ...base, npu: npu('needs_runtime'), dismissed: ['Intel GPU'] });
  expect(back?.devices).toEqual(['Intel GPU', 'Intel NPU']);
});

test('the Labs GPU switch for Parakeet goes while the NPU prepares or runs Parakeet', () => {
  expect(npuOwnsParakeet(npu('preparing'))).toBe(true);
  expect(npuOwnsParakeet(npu('ready'))).toBe(true);
  for (const state of ['absent', 'needs_runtime', 'needs_model', 'waiting', 'failed'] as const) {
    expect(npuOwnsParakeet(npu(state))).toBe(false);
  }
});

test('the card copy follows the NPU state and sums only known sizes', () => {
  expect(parakeetLine(npu('ready'), 'Real time · Best for speed')).toBe('Real time, light on power');
  expect(parakeetLine(npu('failed'), 'Real time · Best for speed')).toBe('Real time');
  expect(parakeetLine(NPU_ABSENT, 'Real time · Best for speed')).toBe('Real time · Best for speed');
  expect(npuNote(npu('preparing'))).toBe('Getting ready for the Intel NPU, once. Live text keeps working meanwhile.');
  expect(npuNote(npu('ready'))).toBeNull();
  expect(npuNote(npu('needs_runtime'))).toBe("Runs on the Intel NPU once Intel's libraries are downloaded.");
  expect(npuNote(npu('needs_runtime'), true)).toContain("once Whisper's Intel GPU version is downloaded");
  expect(sumBytes([640 * MB, 1082 * MB])).toBe(1722 * MB);
  expect(sumBytes([640 * MB, null])).toBeNull();
  expect(sumBytes([])).toBeNull();
});

test('a saved Intel GPU version that is gone stands in for the copy a load of it runs', () => {
  // Missing: the recommended copy it serves, as speech_choice::regular_copy picks it.
  expect(gpuVersionStandIn(whisper, GPU_ID)).toEqual({ version: whisper[2], copy: COPY });
  const full = { name: 'large-v3-turbo', size_bytes: 1, status: 'Available' as const };
  expect(gpuVersionStandIn([whisper[0], full, whisper[2]], GPU_ID)?.copy).toBe('large-v3-turbo');
  // No copy of it (Small serves nothing): the load fails saying what to download.
  expect(gpuVersionStandIn([whisper[0], whisper[2]], GPU_ID)?.copy).toBeNull();
  // Installed, or not an Intel GPU version: nothing stands in.
  expect(gpuVersionStandIn([{ ...whisper[2], status: 'Available' }], GPU_ID)).toBeNull();
  expect(gpuVersionStandIn(whisper, COPY)).toBeNull();
  expect(gpuVersionLabel(whisper[2])).toBe('Whisper · Large V3 Turbo · Intel GPU');
});

test("native errors of Intel's libraries read in device words", () => {
  expect(intelError('Not enough free space for OpenVINO GenAI: it needs 254 MB, 100 MB are free')).toEqual({
    message: 'Not enough free space: it needs 254 MB, 100 MB are free.',
    detail: 'Not enough free space for OpenVINO GenAI: it needs 254 MB, 100 MB are free',
  });
  expect(intelError('The model list has no OpenVINO runtime for this computer.').message).toBe("Intel's libraries for this computer aren't available yet.");
  expect(intelError('The model list offers OpenVINO GenAI 2027.1.0.0, which this version of Protocol cannot run. Update Protocol to use it.').message)
    .toBe("This version of Protocol can't use the Intel libraries on offer. Update Protocol to use them.");
  expect(intelError('Could not delete C:/data/models/openvino/whisper: access denied').message).not.toMatch(/openvino/i);
  expect(intelError('Network error')).toEqual({ message: 'Network error', detail: null });
});
