'use client';

import { useEffect, useState } from 'react';

/**
 * App theme. Colors live in globals.css as channel tokens under
 * `:root[data-theme='light' | 'dark']`; this module decides which one is
 * painted.
 *
 * The preference is stored in localStorage, which the main window and the
 * minibar share, so a change in Settings repaints both. `system` follows the
 * OS light or dark mode, including a switch while the app is open (Windows can
 * switch on a schedule).
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type AppTheme = 'light' | 'dark';

export const THEME_PREFERENCES: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'Match system' },
];

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';
const THEME_STORAGE_KEY = 'meetily_theme';
const THEME_EVENT = 'af-theme-change';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function normalizeThemePreference(value: string | null): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  // Stored before #96, when the app had three named themes.
  if (value === 'vanilla') return 'light';
  if (value === 'midnight' || value === 'charcoal') return 'dark';
  return DEFAULT_THEME_PREFERENCE;
}

/**
 * Under Tauri, prefers-color-scheme reports the window's theme, not the OS
 * one. It follows the OS only while no theme is forced on the window, which is
 * why applyAppTheme clears it for `system`; on Windows Tauri then passes every
 * OS switch on to the webview.
 */
export function resolveTheme(preference: ThemePreference): AppTheme {
  if (preference !== 'system') return preference;
  return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

function paintTheme(theme: AppTheme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', theme === 'dark');
}

export function getSavedThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE;
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/** Paint the document for `preference`. `persist` also saves it and tells other windows. */
export function applyAppTheme(preference: ThemePreference, persist = false) {
  if (typeof window === 'undefined') return;
  paintTheme(resolveTheme(preference));

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Storage can be unavailable in locked-down webviews; the paint still applies.
    }
  }
  window.dispatchEvent(new CustomEvent<ThemePreference>(THEME_EVENT, { detail: preference }));

  if ('__TAURI_INTERNALS__' in window) {
    // null hands the window back to the OS theme; the media query listener in
    // useAppTheme repaints once the webview reports it.
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(preference === 'system' ? null : preference))
      .catch((error) => console.warn('Failed to sync the native window theme:', error));
  }
}

/**
 * Runs in <head> before the first paint so the window never flashes the
 * wrong theme. Kept dependency-free because it is inlined as a string; it
 * must resolve stored values the way normalizeThemePreference does.
 */
export const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var saved = localStorage.getItem('${THEME_STORAGE_KEY}');
    var dark = saved === 'dark' || saved === 'midnight' || saved === 'charcoal'
      || (saved !== 'light' && saved !== 'vanilla' && window.matchMedia('${DARK_QUERY}').matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (dark) root.classList.add('dark');
    else root.classList.remove('dark');
  } catch (_) {}
})();
`;

/**
 * The saved preference and the theme it paints, kept in sync with Settings,
 * the other app window and, for `system`, the OS.
 */
export function useAppTheme(): {
  preference: ThemePreference;
  theme: AppTheme;
  setPreference: (preference: ThemePreference) => void;
} {
  // null until read from storage: resolving the default first would paint the
  // OS theme over a forced one for a frame.
  const [saved, setSaved] = useState<ThemePreference | null>(null);
  const [theme, setTheme] = useState<AppTheme>('dark');

  useEffect(() => {
    setSaved(getSavedThemePreference());
    const onLocal = (event: Event) => setSaved((event as CustomEvent<ThemePreference>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = normalizeThemePreference(event.newValue);
      applyAppTheme(next);
      setSaved(next);
    };
    window.addEventListener(THEME_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (saved === null) return;
    const update = () => {
      const next = resolveTheme(saved);
      paintTheme(next);
      setTheme(next);
    };
    update();
    if (saved !== 'system') return;
    const query = window.matchMedia?.(DARK_QUERY);
    query?.addEventListener('change', update);
    return () => query?.removeEventListener('change', update);
  }, [saved]);

  return { preference: saved ?? DEFAULT_THEME_PREFERENCE, theme, setPreference: saveThemePreference };
}

function saveThemePreference(preference: ThemePreference) {
  applyAppTheme(preference, true);
}
