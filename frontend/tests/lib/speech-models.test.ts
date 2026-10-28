import { expect, test } from 'bun:test';
import {
  installedSpeechModels,
  speechModelDescription,
  speechModelLabel,
  speechModelLanguages,
  speechModelName,
} from '../../src/lib/speech-models';

test('model names drop a repeated engine name and fall back to the id', () => {
  expect(speechModelName('whisper', 'tiny', 'Whisper tiny')).toBe('tiny');
  expect(speechModelName('whisper', 'large-v3-turbo-q5_0', 'Large V3 Turbo Compressed')).toBe('Large V3 Turbo Compressed');
  expect(speechModelName('parakeet', 'parakeet-tdt-0.6b-v3-int8', undefined)).toBe('parakeet-tdt-0.6b-v3-int8');
  expect(speechModelLabel('parakeet', 'parakeet-tdt-0.6b-v3-int8', 'Lightning')).toBe('Parakeet · Lightning');
});

test('descriptions and languages read the way the rest of the UI does', () => {
  expect(speechModelDescription('Real time • Best for speed, great accuracy')).toBe('Real time · Best for speed, great accuracy');
  expect(speechModelLanguages(['*'])).toBe('About 100 languages');
  expect(speechModelLanguages(['en', 'de'])).toBe('2 languages');
  expect(speechModelLanguages(undefined)).toBeNull();
});

test('pickers offer downloaded models only, Parakeet first, and never Parakeet v2', () => {
  const offered = installedSpeechModels(
    [
      { name: 'small', size_bytes: 1, status: 'Missing' },
      { name: 'large-v3-turbo-q5_0', size_bytes: 1, status: 'Available', display_name: 'Large V3 Turbo Compressed', languages: ['*'] },
    ],
    [
      { name: 'parakeet-tdt-0.6b-v2-int8', size_bytes: 1, status: 'Available', display_name: 'Compact' },
      { name: 'parakeet-tdt-0.6b-v3-int8', size_bytes: 1, status: 'Available', display_name: 'Lightning', languages: ['en', 'ru'] },
    ],
  );
  expect(offered).toEqual([
    { provider: 'parakeet', name: 'parakeet-tdt-0.6b-v3-int8', displayName: 'Lightning', languages: ['en', 'ru'] },
    { provider: 'whisper', name: 'large-v3-turbo-q5_0', displayName: 'Large V3 Turbo Compressed', languages: ['*'] },
  ]);
});
