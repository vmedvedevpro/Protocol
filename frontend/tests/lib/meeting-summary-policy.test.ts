import { describe, expect, test } from 'bun:test';
import { keepsSavedSummaryModel, shouldSetUpAutoSummary } from '../../src/lib/meeting-summary-policy';

describe('shouldSetUpAutoSummary', () => {
  test('allows recording summaries when Auto Summary is enabled', () => {
    expect(shouldSetUpAutoSummary('recording', true)).toBe(true);
  });

  test('blocks recording summaries when Auto Summary is disabled', () => {
    expect(shouldSetUpAutoSummary('recording', false)).toBe(false);
  });

  test('does not auto-generate when opening an existing meeting', () => {
    expect(shouldSetUpAutoSummary(null, true)).toBe(false);
  });
});

describe('keepsSavedSummaryModel', () => {
  test('keeps a saved provider and model', () => {
    expect(keepsSavedSummaryModel({ provider: 'claude', model: 'claude-sonnet-4-5' })).toBe(true);
  });

  test('keeps a row whose removed provider loaded as no provider, so generation asks for one', () => {
    expect(keepsSavedSummaryModel({ provider: '', model: '' })).toBe(true);
  });

  test('leaves the gemma3:1b fallback to a database without a settings row', () => {
    expect(keepsSavedSummaryModel(null)).toBe(false);
    expect(keepsSavedSummaryModel(undefined)).toBe(false);
  });

  test('leaves the gemma3:1b fallback to an offered provider without a model, as before', () => {
    expect(keepsSavedSummaryModel({ provider: 'builtin-ai', model: '' })).toBe(false);
  });
});
