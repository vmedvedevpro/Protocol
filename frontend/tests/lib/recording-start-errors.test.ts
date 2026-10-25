import { describe, expect, test } from 'bun:test';
import { describeStartError, modelIntegrityMessage } from '../../src/lib/recording-start-errors';

describe('modelIntegrityMessage', () => {
  test('passes on an integrity failure from the Record button model load', () => {
    // As parakeet_load_model rejects when model_integrity deleted a file.
    const error = 'Failed to load Parakeet model: vocab.txt failed its integrity check and was deleted: it has 4 bytes, expected 9384. Download it again.';
    expect(modelIntegrityMessage(error)).toBe(
      'Recording cannot start: the transcription model failed its integrity check and was deleted. Download it again in Settings.',
    );
    expect(modelIntegrityMessage(new Error(error))).not.toBeNull();
  });

  test('leaves other load failures to the generic message', () => {
    expect(modelIntegrityMessage('Model parakeet-tdt-0.6b-v3-int8 is not available')).toBeNull();
    expect(modelIntegrityMessage('encoder-model.int8.onnx is not fully downloaded: it has 3 of 652183999 bytes.')).toBeNull();
    expect(modelIntegrityMessage(undefined)).toBeNull();
  });
});

describe('describeStartError', () => {
  test('advises opening an app only when none of the chosen apps runs', () => {
    expect(describeStartError('Failed to start recording: No target application is currently running').title)
      .toBe('None of your chosen apps is open');
    expect(describeStartError('No target application is running with audio').title)
      .toBe('Could not start recording');
  });

  test('shows the backend reason for unrecognised errors', () => {
    expect(describeStartError('Failed to start recording: Disk is full')).toEqual({
      title: 'Could not start recording',
      message: 'Disk is full',
    });
  });

  test('reads Error objects and serialized objects instead of "[object Object]"', () => {
    expect(describeStartError(new Error('Disk is full')).message).toBe('Disk is full');
    expect(describeStartError({ message: 'Disk is full' }).message).toBe('Disk is full');
    expect(describeStartError({ code: 7 }).message).toBe('{"code":7}');
  });

  test('falls back to generic advice when there is no reason at all', () => {
    expect(describeStartError(undefined).message).toBe('Check your audio devices in the recording card and try again.');
  });
});
