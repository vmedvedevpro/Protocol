import { expect, mock, test } from 'bun:test';

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, custom: () => {} } }));
mock.module('@/contexts/OnboardingContext', () => ({ useOnboarding: () => ({ currentStep: 6 }) }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));

const { categorizeError } = await import('../../src/components/shared/DownloadProgressToast');

test('integrity failures are reported as such, not as storage errors', () => {
  // Messages as model_integrity.rs writes them; both name a file.
  for (const message of [
    'encoder-model.int8.onnx failed its integrity check and was deleted: its SHA-256 is 00, expected 6139. Download it again.',
    'Qwen3.5-2B-Q4_K_M.gguf failed its integrity check: the server sent 12 bytes, expected 1280835840',
  ]) {
    expect(categorizeError(message)).toStartWith('Integrity check failed');
  }
  expect(categorizeError('Error writing model file: disk full')).toBe('Storage error - Check available disk space');
});
