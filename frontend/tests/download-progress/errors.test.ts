import { expect, mock, test } from 'bun:test';

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, custom: () => {} } }));
mock.module('@/contexts/OnboardingContext', () => ({ useOnboarding: () => ({ currentStep: 6 }) }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));

const { categorizeError } = await import('../../src/components/shared/DownloadProgressToast');

test('integrity failures are reported as such, not as storage errors', () => {
  // Messages as model_integrity.rs writes them; each names a file.
  expect(categorizeError(
    'encoder-model.int8.onnx failed its integrity check and was deleted: its SHA-256 is 00, expected 6139. Download it again.',
  )).toBe('Integrity check failed - The download did not match its pinned checksum and was deleted. Please retry download');
  expect(categorizeError('Error writing model file: disk full')).toBe('Storage error - Check available disk space');
});

test('a wrong length from the server does not claim a deletion', () => {
  // Refused before anything is written; a kept partial download stays.
  const toast = categorizeError(
    'Qwen3.5-2B-Q4_K_M.gguf failed its integrity check: the server sent a file of 12 bytes, expected 1280835840. Nothing was deleted; retry the download.',
  );
  expect(toast).toBe('Integrity check failed - The server sent a file of the wrong size. Nothing was deleted. Please retry download');
  expect(toast).not.toContain('and was deleted');
});

test('a mismatch that could not be deleted says so', () => {
  const toast = categorizeError(
    'ggml-base.bin failed its integrity check and could not be deleted (Access is denied. (os error 5)): its SHA-256 is 00, expected 60ed. Close any program that has it open, then download it again.',
  );
  expect(toast).toStartWith('Integrity check failed - The download did not match its pinned checksum and could not be deleted');
});
