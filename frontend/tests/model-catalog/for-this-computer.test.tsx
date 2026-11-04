import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

let commands: Array<{ command: string; args?: any }>;
let jobs: any;
let toasts: string[];
const startDownload = mock(() => {});
const uninstallModel = mock(() => {});
let downloadResult: () => Promise<void>;
let runtimeResult: () => Promise<void>;
const listeners = new Map<string, Array<(event: { payload: any }) => void>>();
const fire = (name: string, payload: any) => act(async () => { for (const handler of listeners.get(name) ?? []) handler({ payload }); });

mock.module('sonner', () => ({ toast: { success: (title: string) => { toasts.push(title); }, error: (title: string) => { toasts.push(title); } } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, handler: (event: { payload: any }) => void) => {
  listeners.set(name, [...(listeners.get(name) ?? []), handler]);
  return () => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== handler));
} }));
mock.module('@/contexts/OptionalModelDownloadsContext', () => ({
  OPTIONAL_WHISPER_MODEL: 'large-v3-turbo-q5_0',
  useOptionalModelDownloads: () => ({ jobs, startDownload, uninstallModel }),
}));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: any) => {
  commands.push({ command, args });
  if (command === 'openvino_download') return downloadResult();
  if (command === 'openvino_runtime_download') return runtimeResult();
  if (command === 'openvino_status') return null;
  return undefined;
} }));

const { ForThisComputer } = await import('../../src/components/settings/ForThisComputer');
const { IntelGpuDownload } = await import('../../src/components/settings/IntelGpuDownload');
const { downloadIntelLibraries } = await import('../../src/hooks/useIntelLibraries');
const { recommendedPair, gpuFallback, NPU_ABSENT } = await import('../../src/lib/speech-choice');

const MB = 1024 * 1024;
const GPU_ID = 'large-v3-turbo-openvino-int8';
const COPY = 'large-v3-turbo-q5_0';
const PARAKEET = 'parakeet-tdt-0.6b-v3-int8';
const intelGpu = { offer: true, gpu: 'Intel(R) Arc(TM) B390 GPU', reason: null, device: null, mismatch: null };
const otherGpu = { offer: false, gpu: 'NVIDIA', reason: 'not Intel', device: null, mismatch: null };

function companion(extra: Record<string, any> = {}) {
  return {
    id: GPU_ID, name: 'Large V3 Turbo for Intel GPUs', description: '', repo: 'OpenVINO/x', companionOf: ['large-v3-turbo', COPY],
    size: 828 * MB, companionInstalled: false,
    runtime: { name: 'OpenVINO GenAI', version: '2026.4.1.0', license: { name: 'L', url: 'u' }, source: 's', downloadSize: 254 * MB, installedSize: 111 * MB, installed: null, afterRestart: null, removedAtRestart: null },
    installed: false, downloadSize: 1082 * MB, refused: null, downloading: null, progress: null, stopped: null, removesRuntime: true,
    ...extra,
  };
}

interface State {
  parakeet?: string; copy?: string; gpuEntry?: string; availability?: any; companion?: any; npu?: any;
  fallbackReason?: string | null; copyRetires?: boolean; parakeetProgress?: Record<string, number>;
}
function choiceOf(state: State) {
  const whisper = [
    { name: COPY, display_name: 'Large V3 Turbo Compressed', description: 'Large V3 Turbo at a third of the size, best balance', size_bytes: 547 * MB, status: state.copy ?? 'Missing', recommended: true, languages: ['*'] },
    { name: GPU_ID, display_name: 'Large V3 Turbo', size_bytes: 828 * MB, status: state.gpuEntry ?? 'Missing', companion_of: ['large-v3-turbo', COPY], languages: ['*'] },
  ];
  const parakeet = [{ name: PARAKEET, display_name: 'Lightning', description: 'Real time • Best for speed, great accuracy', size_bytes: 640 * MB, status: state.parakeet ?? 'Missing', recommended: true, languages: Array(25).fill('x') }];
  const availability = state.availability === undefined ? intelGpu : state.availability;
  const status = state.companion === undefined ? companion() : state.companion;
  const npu = state.npu ?? NPU_ABSENT;
  const fallbackReason = state.fallbackReason ?? null;
  return {
    loaded: true, whisper, parakeet, availability, companion: status, npu, fallbackReason,
    copyRetires: !!state.copyRetires, parakeetProgress: state.parakeetProgress ?? {},
    pair: recommendedPair({ whisper, parakeet, availability, companion: status, npu } as any),
    devices: { npu, gpuVersion: whisper[1], gpuFallback: gpuFallback(status, fallbackReason, availability) },
    refresh: () => {},
  } as any;
}

let root: ReactTestRenderer;
const onParakeetInstalled = mock(() => {});
const onModelsChanged = mock(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const refresh = mock(() => {});
const render = async (state: State, offerBack: any = null) => {
  await act(async () => {
    root = create(<ForThisComputer choice={{ ...choiceOf(state), refresh }} onParakeetInstalled={onParakeetInstalled} onModelsChanged={onModelsChanged} offerBack={offerBack} />);
    await settle();
  });
};
/** The statuses asked again: the same card with new ones. */
const rerender = async (state: State) => {
  await act(async () => {
    root.update(<ForThisComputer choice={{ ...choiceOf(state), refresh }} onParakeetInstalled={onParakeetInstalled} onModelsChanged={onModelsChanged} offerBack={null} />);
    await settle();
  });
};
const text = () => JSON.stringify(root.toJSON());
const label = (node: any): string => node.children.map((child: any) => (typeof child === 'string' ? child : label(child))).join('');
const buttonText = (match: string | RegExp) =>
  root.root.find((node) => node.type === 'button' && (typeof match === 'string' ? label(node) === match : match.test(label(node))));
const click = async (match: string | RegExp) => act(async () => { buttonText(match).props.onClick(); await settle(); });
const called = (command: string) => commands.filter((entry) => entry.command === command);

beforeEach(() => {
  commands = [];
  toasts = [];
  jobs = { whisper: { status: 'idle', progress: 0 }, nemotron: { status: 'idle', progress: 0 } };
  downloadResult = async () => {};
  runtimeResult = async () => {};
  startDownload.mockClear(); uninstallModel.mockClear(); onParakeetInstalled.mockClear(); onModelsChanged.mockClear(); refresh.mockClear();
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('N1: a fresh Intel PC gets the pair with its devices and one button for both, sized from the catalog', async () => {
  await render({ npu: { present: true, state: 'needs_runtime', active: false, reason: null } });
  expect(text()).toContain('Parakeet Lightning');
  expect(text()).toContain('Whisper Large V3 Turbo');
  expect(text()).not.toContain('Compressed');
  expect(text()).toContain('Intel NPU');
  expect(text()).toContain('Intel GPU');
  expect(text()).toContain('Real time, light on power · 640 MB · 25 languages');
  expect(text()).toContain('Best accuracy, fast on this computer · 1.1 GB · About 100 languages');
  // Parakeet 640 MB + the Intel GPU version with Intel's libraries 1082 MB.
  await click('Download both · 1.7 GB');
  expect(called('parakeet_download_model')[0].args).toEqual({ modelName: PARAKEET });
  expect(called('openvino_download')[0].args).toEqual({ id: GPU_ID, choose: true });
  // Intel's libraries come with the Intel GPU version; no separate download.
  expect(called('openvino_runtime_download')).toHaveLength(0);
  expect(onParakeetInstalled).toHaveBeenCalledWith(PARAKEET);
  expect(toasts).toContain('Whisper is ready for the Intel GPU');
});

test('N7: another PC gets Parakeet and the Compressed copy without badges, through the optional Whisper job', async () => {
  await render({ availability: otherGpu });
  expect(text()).toContain('Whisper Large V3 Turbo Compressed');
  expect(text()).toContain('Real time · Best for speed, great accuracy · 640 MB');
  expect(text()).toContain('Large V3 Turbo at a third of the size, best balance · 547 MB · About 100 languages');
  expect(text()).not.toContain('Intel');
  await click('Download both · 1.2 GB');
  expect(startDownload).toHaveBeenCalledWith('whisper');
  expect(called('openvino_download')).toHaveLength(0);
});

test('an NPU-only PC downloads Intel\'s libraries with the pair, and offers them alone once Parakeet is in', async () => {
  const npu = { present: true, state: 'needs_runtime', active: false, reason: null };
  await render({ availability: otherGpu, npu });
  // 640 + 547 + 254 MB.
  await click('Download both · 1.4 GB');
  expect(called('openvino_runtime_download')).toHaveLength(1);
  await act(async () => root.unmount());
  commands = [];
  await render({ availability: otherGpu, npu, parakeet: 'Available', copy: 'Available' });
  expect(text()).toContain("Runs on the Intel NPU once Intel's libraries are downloaded.");
  await click("Download Intel's libraries · 254 MB");
  expect(called('openvino_runtime_download')).toHaveLength(1);
});

test("Intel's libraries alone show their bytes with Cancel, keep a failure, and follow a download already running", async () => {
  const npu = { present: true, state: 'needs_runtime', active: false, reason: null };
  const installed = { availability: otherGpu, npu, parakeet: 'Available', copy: 'Available' };
  let finish: (error?: string) => void = () => {};
  runtimeResult = () => new Promise<void>((resolve, reject) => { finish = (error) => (error ? reject(error) : resolve()); });
  await render(installed);
  await click("Download Intel's libraries · 254 MB");
  expect(text()).toContain("Downloading Intel's libraries…");
  await fire('openvino-runtime-progress', { done: 100 * MB, total: 254 * MB });
  expect(text()).toContain("Intel's libraries · 100 MB of 254 MB");
  await act(async () => { root.root.findByProps({ 'aria-label': "Cancel downloading Intel's libraries" }).props.onClick(); await settle(); });
  expect(called('openvino_cancel')[0].args).toEqual({ id: 'openvino-genai' });
  await act(async () => { finish('The download was cancelled'); await settle(); });
  expect(text()).not.toContain('MB of 254 MB');
  expect(root.root.findAll((node) => node.props?.role === 'alert')).toHaveLength(0);
  // The same events also come from an Intel GPU download: they start no job here.
  await fire('openvino-runtime-progress', { done: 10 * MB, total: 254 * MB });
  expect(text()).not.toContain('10 MB of 254 MB');

  // A failure stays with the job until the next try.
  runtimeResult = async () => { throw 'Not enough space'; };
  await click("Download Intel's libraries · 254 MB");
  expect(text()).toContain("Intel's libraries didn't download: Not enough space");
  await act(async () => root.unmount());
  await render(installed);
  expect(text()).toContain("Intel's libraries didn't download: Not enough space");

  // Started before a reload: the card follows it until the NPU leaves needs_runtime.
  runtimeResult = async () => { throw "Intel's libraries are already downloading"; };
  await click("Download Intel's libraries · 254 MB");
  expect(text()).not.toContain("didn't download");
  await fire('openvino-runtime-progress', { done: 200 * MB, total: 254 * MB });
  expect(text()).toContain("Intel's libraries · 200 MB of 254 MB");
  await fire('parakeet-npu-status', { present: true, state: 'preparing', active: false, reason: null });
  expect(text()).not.toContain('MB of 254 MB');
});

test('N3: switching shows the download in its own bytes with Cancel, and the NPU preparing once', async () => {
  await render({
    parakeet: 'Available', copy: 'Available',
    companion: companion({ downloading: 62, progress: { done: 620 * MB, total: 1000 * MB } }),
    npu: { present: true, state: 'preparing', active: false, reason: null },
  });
  expect(text()).toContain('Downloading · 620 MB of 1000 MB');
  expect(text()).toContain('The Compressed copy stays until this one has transcribed a meeting.');
  expect(text()).toContain('Getting ready for the Intel NPU, once. Live text keeps working meanwhile.');
  expect(text()).toContain('Preparing · about 2 min');
  expect(text()).not.toContain('Download both');
  await act(async () => { root.root.findByProps({ 'aria-label': 'Cancel downloading Whisper Large V3 Turbo' }).props.onClick(); await settle(); });
  expect(called('openvino_cancel')[0].args).toEqual({ id: GPU_ID });
});

test('N4: installed models show Installed and Remove; removing the Intel GPU version goes through native code', async () => {
  await render({
    parakeet: 'Available', copy: 'Missing', gpuEntry: 'Available',
    companion: companion({ installed: true, companionInstalled: true }),
    npu: { present: true, state: 'ready', active: true, reason: null },
  });
  expect(text().match(/Installed/g)).toHaveLength(2);
  expect(text()).not.toContain('The Compressed copy stays');
  const remove = root.root.findByProps({ 'aria-label': 'Remove Whisper Large V3 Turbo' });
  await act(async () => { remove.props.onClick(); await settle(); });
  // The confirmation runs the removal.
  const dialogs = root.root.findAll((node) => node.props?.confirmLabel === 'Remove' && node.props?.open === true);
  await act(async () => { await dialogs[0].props.onConfirm(); await settle(); });
  expect(called('speech_choice_remove_gpu_version')[0].args).toEqual({ id: GPU_ID });
  expect(onModelsChanged).toHaveBeenCalled();
});

test('the Compressed copy is said to stay only while it waits to retire', async () => {
  const installed = { parakeet: 'Available', copy: 'Available', gpuEntry: 'Available', companion: companion({ installed: true, companionInstalled: true }) };
  await render({ ...installed, copyRetires: true });
  expect(text()).toContain('The Compressed copy stays until this one has transcribed a meeting.');
  await act(async () => root.unmount());
  // Chosen before #88, or downloaded on purpose later: no promise to remove it.
  await render({ ...installed, copyRetires: false });
  expect(text()).not.toContain('The Compressed copy stays');
});

test('N6: a failed NPU and a fallen-back Intel GPU version say what runs instead, with Try again', async () => {
  const fellBack: State = {
    parakeet: 'Available', copy: 'Available', gpuEntry: 'Available',
    companion: companion({ installed: true, companionInstalled: true }),
    npu: { present: true, state: 'failed', active: false, reason: 'NPU compile failed' },
    fallbackReason: 'GPU compile failed',
  };
  await render(fellBack);
  expect(text()).toContain("The Intel NPU didn't start, so Parakeet runs on the processor.");
  expect(text()).toContain("The Intel GPU version didn't start, so Whisper uses this copy. Nothing to download.");
  // The copy that runs is the row, without badges.
  expect(text()).toContain('Whisper Large V3 Turbo Compressed');
  expect(text()).toContain('Best accuracy · 547 MB');
  expect(text()).toContain('Real time · 640 MB');
  expect(text()).not.toContain('Intel NPU"');
  const tries = root.root.findAll((node) => node.type === 'button' && label(node) === 'Try again');
  expect(tries).toHaveLength(2);
  await act(async () => { tries[0].props.onClick(); tries[1].props.onClick(); await settle(); });
  expect(called('parakeet_npu_retry')).toHaveLength(1);
  expect(called('openvino_retry')).toHaveLength(1);
  expect(refresh).toHaveBeenCalled();
  // Native code forgets the fallback on retry: the statuses asked again hide the notice…
  await rerender({ ...fellBack, fallbackReason: null });
  expect(text()).not.toContain('so Whisper uses this copy');
  // …and it comes back when the next transcription falls back again.
  await rerender(fellBack);
  expect(text()).toContain("The Intel GPU version didn't start, so Whisper uses this copy.");
});

test('a fallen-back Intel GPU version without a regular copy offers the standard version, keeping the choice', async () => {
  await render({
    parakeet: 'Available', copy: 'Missing', gpuEntry: 'Available',
    companion: companion({ installed: true, companionInstalled: true, stopped: 'Protocol closed unexpectedly' }),
  });
  expect(text()).toContain("The Intel GPU version didn't start, and no regular copy is installed");
  await click('Download the standard version · 547 MB');
  // A plain download: the after-meeting choice stays on the Intel GPU version, which falls back to it.
  expect(called('whisper_download_model')[0].args).toEqual({ modelName: COPY, enablePostCall: false });
  expect(startDownload).not.toHaveBeenCalled();
});

test("an Intel GPU version installed before the NPU files came gets Intel's libraries as a download of their own", async () => {
  // 0.5.0 installed the libraries without the NPU's files: #66 reads needs_runtime.
  const npu = { present: true, state: 'needs_runtime', active: false, reason: null };
  await render({ parakeet: 'Available', gpuEntry: 'Available', companion: companion({ installed: true, companionInstalled: true }), npu });
  expect(text()).toContain("Runs on the Intel NPU once Intel's libraries are downloaded.");
  expect(text()).not.toContain("Whisper's Intel GPU version is downloaded");
  await click("Download Intel's libraries · 254 MB");
  expect(called('openvino_runtime_download')).toHaveLength(1);
});

test('download and removal errors use device words, the original in a tooltip', async () => {
  downloadResult = async () => { throw 'Not enough free space for OpenVINO GenAI: it needs 254 MB, 100 MB are free'; };
  await render({ parakeet: 'Available' });
  await click('Download · 1.1 GB');
  const alert = root.root.find((node) => node.props?.role === 'alert');
  expect(label(alert)).toBe('Not enough free space: it needs 254 MB, 100 MB are free.');
  expect(alert.props.title).toContain('OpenVINO GenAI');
  await act(async () => root.unmount());
  downloadResult = async () => { throw 'The model list has no OpenVINO runtime for this computer.'; };
  await render({ parakeet: 'Available' });
  await click('Download · 1.1 GB');
  expect(text()).toContain("Intel's libraries for this computer aren't available yet.");
  expect(text().replace(/"title":"[^"]*"/g, '')).not.toMatch(/OpenVINO/);
});

test('one missing model gets its own button; a failed download says why', async () => {
  downloadResult = async () => { throw 'Not enough space'; };
  await render({ parakeet: 'Available' });
  expect(text()).not.toContain('Download both');
  await click('Download · 1.1 GB');
  expect(text()).toContain('Not enough space');
  await act(async () => root.unmount());
  // A cancelled download is no failure.
  downloadResult = async () => { throw 'The download was cancelled'; };
  await render({ parakeet: 'Available' });
  await click('Download · 1.1 GB');
  expect(root.root.findAll((node) => node.props?.role === 'alert')).toHaveLength(0);
});

test('a newer version of Intel\'s libraries is offered as an update in the card', async () => {
  const runtime = { ...companion().runtime, installed: '2026.3.0.0' };
  await render({ parakeet: 'Available', gpuEntry: 'Available', companion: companion({ installed: true, companionInstalled: true, runtime }) });
  expect(text()).toContain("An update to Intel's libraries is available · 254 MB");
  await act(async () => { root.root.findByProps({ 'aria-label': "Update Intel's libraries" }).props.onClick(); await settle(); });
  expect(called('openvino_download')[0].args).toEqual({ id: GPU_ID, choose: false });
});

test('the way back to a put-off offer sits under the card', async () => {
  const back = mock(() => {});
  await render({ parakeet: 'Available', copy: 'Available' }, { label: 'Use your Intel GPU…', onClick: back });
  await click('Use your Intel GPU…');
  expect(back).toHaveBeenCalled();
});

test('no UI word names the libraries or the runtimes', async () => {
  for (const state of [
    {},
    { parakeet: 'Available', copy: 'Available', gpuEntry: 'Available', companion: companion({ installed: true, companionInstalled: true, stopped: 'x' }), npu: { present: true, state: 'failed', active: false, reason: 'OpenVINO NPU plugin' } },
    { availability: otherGpu },
  ]) {
    await render(state);
    const visible = JSON.stringify(root.toJSON()).replace(/"title":"[^"]*"/g, '');
    expect(visible).not.toMatch(/OpenVINO|DirectML|ONNX|Vulkan|runtime|plugin/i);
    await act(async () => root.unmount());
  }
});

test("onboarding's download step follows the Intel GPU version, or Intel's libraries on an NPU-only PC", async () => {
  await act(async () => {
    root = create(<IntelGpuDownload choice={choiceOf({ companion: companion({ downloading: 25, progress: { done: 250 * MB, total: 1000 * MB } }) })} />);
    await settle();
  });
  expect(text()).toContain('Whisper Large V3 Turbo');
  expect(text()).toContain('Downloading · 250 MB of 1000 MB');
  await act(async () => root.unmount());

  let finish: () => void = () => {};
  runtimeResult = () => new Promise<void>((resolve) => { finish = resolve; });
  const npu = { present: true, state: 'needs_runtime', active: false, reason: null };
  await act(async () => {
    root = create(<IntelGpuDownload choice={choiceOf({ availability: otherGpu, npu })} />);
    await settle();
  });
  expect(root.toJSON()).toBeNull();
  // Setup starts it detached; the step shows it from the shared job.
  let started: Promise<string> = Promise.resolve('');
  await act(async () => { started = downloadIntelLibraries(); await settle(); });
  await fire('openvino-runtime-progress', { done: 127 * MB, total: 254 * MB });
  expect(text()).toContain("Intel's libraries for the NPU");
  expect(text()).toContain('Downloading · 127 MB of 254 MB');
  await act(async () => { finish(); await started; await settle(); });
  expect(root.toJSON()).toBeNull();
});
