// Run with: pnpm dlx bun@1.3.10 test tests/lib/app-theme.test.ts
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeThemePreference,
  resolveTheme,
  THEME_BOOT_SCRIPT,
  type AppTheme,
} from '../../src/lib/app-theme';

// Every value the theme key has held: the current preferences, the three named
// themes before #96, the older light/dark toggle, and nothing saved.
const STORED = ['light', 'dark', 'system', 'midnight', 'vanilla', 'charcoal', null, 'unknown'];

function fakeMatchMedia(osDark: boolean) {
  return (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && osDark });
}

function withWindow(osDark: boolean) {
  (globalThis as { window?: unknown }).window = { matchMedia: fakeMatchMedia(osDark) };
}

/** Runs the inline <head> script against a fake document and returns what it painted. */
function bootPaint(stored: string | null, osDark: boolean) {
  const attributes = new Map<string, string>();
  const classes = new Set<string>(['dark']);
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    },
  };
  const localStorage = { getItem: () => stored };
  const window = { matchMedia: fakeMatchMedia(osDark) };
  new Function('localStorage', 'window', 'document', THEME_BOOT_SCRIPT)(localStorage, window, document);
  return { theme: attributes.get('data-theme'), dark: classes.has('dark') };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('theme preference', () => {
  test('maps the old named themes onto light and dark', () => {
    assert.equal(normalizeThemePreference('midnight'), 'dark');
    assert.equal(normalizeThemePreference('charcoal'), 'dark');
    assert.equal(normalizeThemePreference('vanilla'), 'light');
  });

  test('follows the system when nothing valid is saved', () => {
    assert.equal(normalizeThemePreference(null), 'system');
    assert.equal(normalizeThemePreference('unknown'), 'system');
  });

  test('a forced theme ignores the OS mode', () => {
    withWindow(true);
    assert.equal(resolveTheme('light'), 'light');
    withWindow(false);
    assert.equal(resolveTheme('dark'), 'dark');
  });

  test('system reads the OS mode', () => {
    withWindow(true);
    assert.equal(resolveTheme('system'), 'dark');
    withWindow(false);
    assert.equal(resolveTheme('system'), 'light');
  });
});

describe('boot script', () => {
  for (const osDark of [true, false]) {
    for (const stored of STORED) {
      test(`paints like the module for ${String(stored)} with the OS ${osDark ? 'dark' : 'light'}`, () => {
        withWindow(osDark);
        const expected: AppTheme = resolveTheme(normalizeThemePreference(stored));
        assert.deepEqual(bootPaint(stored, osDark), { theme: expected, dark: expected === 'dark' });
      });
    }
  }
});
