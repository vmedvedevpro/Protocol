/**
 * Design tokens. Values come from the `vercel` palette of the design canvas;
 * the window is greyscale, and the recording ring is its only colored element.
 *
 * Both themes share every key, so a component reads `theme.colors.muted` and
 * never branches on the mode.
 */

import {cubicBezier, durations, easings} from './motion'

export type ThemeName = 'light' | 'dark'

export interface ThemeColors {
    /** Window background. */
    bg: string
    /** Tab tracks, cards, a highlighted row. */
    surface: string
    /** The selected tab, buttons, inputs. */
    raised: string
    text: string
    /** Body text one step below `text`. */
    soft: string
    /** Secondary lines, placeholders, icons. */
    muted: string
    border: string
    /** Dims the window under a dialog. */
    scrim: string
}

export interface ThemeShadows {
    /** The selected tab or segment over its track. */
    raised: string
    /** A floating bar, such as the minibar. */
    popover: string
    /** A dialog over the dimmed window. */
    dialog: string
}

const colors: Record<ThemeName, ThemeColors> = {
    light: {
        bg: '#FCFCFC',
        surface: '#F2F2F2',
        raised: '#FFFFFF',
        text: '#000000',
        soft: '#262626',
        muted: '#525252',
        border: '#E4E4E4',
        scrim: 'rgba(0, 0, 0, 0.28)',
    },
    dark: {
        bg: '#0A0A0A',
        surface: '#1A1A1A',
        raised: '#232323',
        text: '#FFFFFF',
        soft: '#D4D4D4',
        muted: '#A4A4A4',
        border: '#262626',
        scrim: 'rgba(0, 0, 0, 0.55)',
    },
}

const shadows: Record<ThemeName, ThemeShadows> = {
    light: {
        raised: '0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.04)',
        popover: '0 12px 32px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)',
        dialog: '0 24px 60px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.06)',
    },
    dark: {
        raised: '0 0 0 1px rgba(255, 255, 255, 0.06)',
        popover: '0 12px 32px rgba(0, 0, 0, 0.55)',
        dialog: '0 24px 60px rgba(0, 0, 0, 0.6)',
    },
}

/**
 * The recording ring (components/ring), the window's only colored element:
 * the three stops its gradient turns through, the highlight that walks around
 * it, and how strongly its halo shows (0 to 1). The colors are those of the
 * design's shader; the small static ring uses the same three stops.
 */
export interface RingPalette {
    violet: string
    blue: string
    cyan: string
    highlight: string
    halo: number
}

const ring: Record<ThemeName, RingPalette> = {
    light: {violet: '#7845F2', blue: '#2E66F2', cyan: '#0599BF', highlight: '#9EB3FF', halo: 0.1},
    // Lighter stops and a stronger halo: on black the glow is what reads.
    dark: {violet: '#996BFF', blue: '#5C94FF', cyan: '#6BE0FA', highlight: '#FFFFFF', halo: 0.22},
}

// The family names @fontsource-variable registers; the fonts ship with the app
// (src/styles/fonts.ts), so every platform renders the same glyphs.
const fonts = {
    sans: "'Geist Variable', system-ui, sans-serif",
    mono: "'Geist Mono Variable', ui-monospace, monospace",
}

/**
 * Text styles as style objects, used whole: `${({theme}) => theme.text.body}`.
 * Desktop density: body text is 13 px, controls 12.5 px.
 */
const text = {
    /** Minibar status, keyboard hints. */
    caption: {fontSize: '11px', lineHeight: '14px'},
    /** Secondary lines under a title. */
    small: {fontSize: '12px', lineHeight: '16px'},
    /** Buttons, tabs, segments. */
    label: {fontSize: '12.5px', lineHeight: '18px', fontWeight: 500},
    body: {fontSize: '13px', lineHeight: '20px'},
    /** Inputs and the search field. */
    input: {fontSize: '14px', lineHeight: '20px'},
    /** The recording timer, in Geist Mono with tabular figures. */
    timer: {fontSize: '14px', lineHeight: '18px', fontWeight: 600},
    title: {fontSize: '18px', lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.01em'},
    display: {fontSize: '22px', lineHeight: '28px', fontWeight: 600, letterSpacing: '-0.02em'},
}

const fontWeights = {
    regular: 400,
    medium: 500,
    semibold: 600,
}

const radii = {
    /** Keyboard hints, progress bars. */
    xs: '4px',
    /** Small buttons, tabs, segments. */
    sm: '6px',
    /** Buttons, inputs, list rows. */
    md: '8px',
    /** The window. */
    lg: '10px',
    /** Cards, dialogs. */
    xl: '12px',
    pill: '999px',
}

/** Spacing on a 4 px grid: the key times 4 is the size in px. */
const space = {
    0.5: '2px',
    1: '4px',
    1.5: '6px',
    2: '8px',
    2.5: '10px',
    3: '12px',
    3.5: '14px',
    4: '16px',
    5: '20px',
    6: '24px',
    8: '32px',
    9: '36px',
}

const sizes = {
    /** Control heights: compact buttons and segments, regular buttons, inputs. */
    control: {sm: '28px', md: '32px', lg: '36px'},
    /** The compact desktop window the design is drawn for. */
    window: {width: '460px', height: '700px'},
    /** The window's title strip and its bottom bar (the recording panel). */
    bar: {header: '44px', footer: '56px'},
    /**
     * The level meter: one bar's width and full height, the source icon
     * beside it, and the smallest width of the mute button that holds them,
     * so the button keeps its width when the bars give way to "Muted".
     */
    meter: {bar: '3px', height: '16px', icon: '14px', button: '76px'},
}

/** Motion tokens for CSS transitions; the values live in ./motion.ts. */
const motion = {
    duration: {
        fast: `${durations.fast}ms`,
        base: `${durations.base}ms`,
        slow: `${durations.slow}ms`,
    },
    easing: {
        standard: cubicBezier(easings.standard),
        enter: cubicBezier(easings.enter),
        exit: cubicBezier(easings.exit),
    },
}

function makeTheme(name: ThemeName) {
    return {
        name,
        colors: colors[name],
        shadows: shadows[name],
        ring: ring[name],
        fonts,
        text,
        fontWeights,
        radii,
        space,
        sizes,
        motion,
    }
}

export type AppTheme = ReturnType<typeof makeTheme>

export const lightTheme: AppTheme = makeTheme('light')
export const darkTheme: AppTheme = makeTheme('dark')

export const themes: Record<ThemeName, AppTheme> = {light: lightTheme, dark: darkTheme}
