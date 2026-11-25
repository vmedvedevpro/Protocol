/**
 * Design tokens. Values come from the `vercel` palette of the design canvas;
 * the window is greyscale, and the recording ring is its only colored element.
 *
 * Both themes share every key, so a component reads `theme.colors.muted` and
 * never branches on the mode.
 */

import {cubicBezier, durations, easings, spinner} from './motion'

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
    /** A hairline between areas: a card's edge, a divider. */
    border: string
    /**
     * The edge of a control: a text field, a select, a secondary button, a
     * radio tile, the import drop area. At least 3:1 (WCAG 1.4.11) against
     * the control's own fill (`raised`) and every surface it sits on (`bg`, a
     * card's `surface`, a sheet's `raised`): light 3.1:1 against `surface`,
     * its lowest, dark 3.1:1 against `raised`. `border`, a hairline between
     * areas, is not meant to: in the dark palette it is three steps above
     * `raised`, so a field on a sheet lost its edge (#208). Hover (`muted`)
     * and focus (`text`, 2 px) stay apart from it in both palettes.
     */
    controlBorder: string
    /** Dims the window under a dialog. */
    scrim: string
    /** A switch's track while it is off. */
    track: string
    /** A switch's knob while it is off; on, the knob takes `bg` over a `text` track. */
    knob: string
    /** A hint laid on a filled button, such as its shortcut. */
    fillHint: string
    /**
     * Close among the Windows caption buttons under the pointer, and its
     * glyph: the system's red, the one colour the window takes from the OS.
     */
    captionClose: string
    captionCloseText: string
}

export interface ThemeShadows {
    /** The selected tab or segment over its track. */
    raised: string
    /** A floating bar (the minibar), menus, select lists, tooltips. */
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
        controlBorder: '#8A8A8A',
        scrim: 'rgba(0, 0, 0, 0.28)',
        track: '#D4D4D4',
        knob: '#FFFFFF',
        fillHint: 'rgba(255, 255, 255, 0.18)',
        captionClose: '#C42B1C',
        captionCloseText: '#FFFFFF',
    },
    dark: {
        bg: '#0A0A0A',
        surface: '#1A1A1A',
        raised: '#232323',
        text: '#FFFFFF',
        soft: '#D4D4D4',
        muted: '#A4A4A4',
        border: '#262626',
        controlBorder: '#6E6E6E',
        scrim: 'rgba(0, 0, 0, 0.55)',
        track: '#3A3A3A',
        knob: '#A4A4A4',
        fillHint: 'rgba(0, 0, 0, 0.12)',
        captionClose: '#C42B1C',
        captionCloseText: '#FFFFFF',
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
    /** Secondary lines under a title, segments, tooltips. */
    small: {fontSize: '12px', lineHeight: '16px'},
    /** Compact buttons and tabs. */
    label: {fontSize: '12.5px', lineHeight: '18px', fontWeight: 500},
    body: {fontSize: '13px', lineHeight: '20px'},
    /** Inputs and the search field. */
    input: {fontSize: '14px', lineHeight: '20px'},
    /** The recording timer, in Geist Mono with tabular figures. */
    timer: {fontSize: '14px', lineHeight: '18px', fontWeight: 600},
    /** A sheet's title. */
    heading: {fontSize: '15px', lineHeight: '22px', fontWeight: 600},
    /** A screen's h1, in the row under the title bar ("Meetings", a meeting's title). */
    screen: {fontSize: '16px', lineHeight: '22px', fontWeight: 600, letterSpacing: '-0.01em'},
    title: {fontSize: '18px', lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.01em'},
    display: {fontSize: '22px', lineHeight: '28px', fontWeight: 600, letterSpacing: '-0.02em'},
    /** What the user writes in the notes editor. */
    notes: {fontSize: '14px', lineHeight: '23px'},
    /** A top-level heading inside the notes. */
    notesHeading: {fontSize: '16px', lineHeight: '22px', fontWeight: 600},
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
    /**
     * Control heights. sm: compact buttons, segments, fields inside a settings
     * row; base: regular buttons (a sheet's footer, Record); md: text fields,
     * the tabs track, larger icon buttons; lg: a field that stands alone, such
     * as the name on first launch.
     */
    control: {sm: '28px', base: '30px', md: '32px', lg: '36px'},
    /** A switch's track; its knob fills the height less the track's padding. */
    switch: {width: '32px', height: '18px'},
    /** A radio button's ring, the stroke it is drawn with, and the dot it shows when chosen. */
    radio: {size: '16px', ring: '1.5px', dot: '8px'},
    /** A progress bar's thickness. */
    progress: '3px',
    /** A menu or a select's list is at least `minWidth`; a select's button at most `triggerMaxWidth`. */
    popover: {minWidth: '128px', triggerMaxWidth: '190px'},
    /** The compact desktop window the design is drawn for. */
    window: {width: '460px', height: '700px'},
    /**
     * The room a sheet or a toast leaves above itself for the window's title
     * strip (at least as tall as the strip on any platform),
     * the meeting's player bar, and the recording bar docked at the bottom
     * with the ring (`dockRing`) at its start.
     */
    bar: {header: '44px', footer: '56px', dock: '64px', dockRing: '56px'},
    /**
     * The title strip on each platform, as the design draws them, and on
     * macOS the room the traffic lights take at its start: their 13 px
     * inset (tauri.macos.conf.json), three 12 px lights 8 px apart and a
     * 12 px gap. `caption` is one Windows caption button's width. On Linux
     * it is the app's row under the desktop's own title bar.
     */
    titleBar: {macos: '38px', windows: '36px', linux: '40px', trafficLights: '78px', caption: '46px'},
    /**
     * The level meter: one bar's width and full height, the source icon
     * beside it, and the smallest width of the mute button that holds them,
     * so the button keeps its width when the bars give way to "Muted".
     */
    meter: {bar: '3px', height: '16px', icon: '14px', button: '76px'},
    /**
     * The transcript's time column, for `mm:ss` and, once a meeting passes
     * an hour, `h:mm:ss`; and the height a row is taken to have until it is
     * first drawn (rows off screen are not laid out, see TranscriptList).
     */
    transcript: {time: '44px', timeLong: '56px', rowEstimate: '64px'},
    /** A folder chip on the meetings list, and its New folder button. */
    chip: '26px',
    /**
     * The minibar: its window at its widest (`MINIBAR_WIDTH` and
     * `MINIBAR_HEIGHT` in minibar.rs; it follows the pill's width), the open
     * pill with room for a longer status; the pill is the window's height. The ring has 1 px to spare above and
     * below inside the pill's border; the timer column holds `h:mm:ss`.
     */
    minibar: {width: '512px', height: '52px', ring: '48px', clock: '64px'},
    /** Search (⌘K): its field's row, a result's icon tile and the glyph in it, and the row of key hints. */
    search: {field: '48px', icon: '26px', glyph: '14px', hints: '36px'},
    /** The person screen's Details: the column of field names. */
    detailLabel: '72px',
    /**
     * The narrowest the settings search stands beside the section tabs.
     * Its "Search" placeholder, the magnifier and the field's padding take
     * 77 px in Geist (Chromium and WebKitGTK measure the same); the rest is
     * slack for another renderer's text. Below it the field wraps to a line
     * of its own (SettingsPage).
     */
    settingsSearch: '96px',
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
    spinner: {
        turn: `${spinner.turn}ms`,
        delay: `${spinner.delay}ms`,
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
