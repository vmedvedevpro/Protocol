# UI architecture

The UI in `frontend/` is a Vite app: React 19, React Router 7, TanStack Query 5,
Zustand 5 and styled-components 6, in TypeScript. It runs in Tauri's webview
and talks to the native side only through Tauri commands and events. This note
is the set of rules for adding to it; the design canvas is the source for every
screen, and [PARITY.md](ui-rewrite/PARITY.md) lists what each task must carry
over from the old UI.

```text
pnpm dev               the UI alone at http://localhost:3119, on mock IPC
pnpm storybook         stories at http://localhost:6006
pnpm run lint
pnpm test              Vitest, once (pnpm test:watch to keep watching)
pnpm run build         tsc -b, then vite build into frontend/out
pnpm run build-storybook
pnpm run tauri:dev     the desktop app; Tauri starts Vite on 3118 (devUrl)
```

## Folder layout

```text
src/
  main.tsx             entry: mock IPC outside Tauri in dev, QueryClientProvider, App
  app/                 the composition root: App, routes, AppThemeProvider,
                       app-wide sync hooks
    shell/             the main window's frame (Window shell below)
  api/                 native domains shared by several features (see below)
  components/ui/       design-system primitives, no feature knowledge
  components/editor/   the notes editor (BlockNote), loaded as its own chunk; its
                       schema names checklist checkboxes by their item's text
  components/transcript/  the transcript of a saved or a live meeting
  components/screen/   Screen: a route's <main> and the footer it docks bars in
  features/<x>/
    api/               native domains only this feature uses
    components/
    hooks/             queries, mutations, event syncs
    pages/             route components
    store/             Zustand stores of client state
    types/
  lib/                 helpers without feature knowledge (queryClient, platform,
                       paths, hotkeys)
  styles/              tokens, GlobalStyle, fonts, icon defaults, theme mode
  mocks/               the in-memory mock IPC and its state
  test/                Vitest setup and fakes
```

A feature imports from `components`, `api`, `lib` and `styles`, never from
another feature. Something two features need moves down to one of those.
`app/` is the composition root: it imports features and puts them together,
and nothing imports it: features, `components`, `api` and `lib` never import
from `app/`. Where a shared piece shows something a feature owns, `app/`
hands it down, as the shell gives `Screen` the recording bar
(`RecordBarContext`).

`src/lib/claude-output-limits.json` also belongs to native code:
`src-tauri/src/summary/llm_client.rs` embeds it with `include_str!` at compile
time, so moving or renaming it breaks the native build, which the frontend
checks do not run. The old summary settings (`162e8be`) read their limits
from it, and the new ones should too.

Two windows load the same `index.html`: the main window at `/`, and the minibar,
which `minibar.rs` opens as `WebviewUrl::App("minibar")`, at `/minibar`. Tauri's
asset resolver falls back to `index.html` for that path (as the Vite dev server
does), so a new window needs a route, not a new entry. A route outside the
router's list goes to `/`. Window shell below has the routes.

## Window shell

`app/shell/` is the frame every screen of the main window lives in (#110):
the title bar, the startup gate and the shell's own commands; each screen
renders `components/screen/Screen` with the bars docked under it. The
minibar window has none of it.

### Window and title bar

- The main window opens at 460×700 and stays resizable, down to 360×480:
  360 px keeps room for the docked bar's status beside its 56 px ring and
  Record or Stop, and for the Windows strip beside its three 46 px caption
  buttons; 480 px leaves the content room under the title bar, a screen's
  header and the bar. `tauri.conf.json` holds the window for Windows and
  Linux; `tauri.macos.conf.json` repeats the whole entry for its title bar,
  since a platform file replaces the `windows` array.
- The app draws the title strip (`TitleBar`, the `<header>`) on every
  platform, as the design does: macOS keeps its traffic lights over an overlay
  title bar (`titleBarStyle: Overlay`, `hiddenTitle`, `trafficLightPosition`
  {13, 17}: tao makes the title bar the buttons' height plus `y` and leaves
  the buttons at AppKit's offset from its bottom, which centres them on the
  38 px strip; not yet checked on a Mac) and the strip starts after them;
  Windows (`decorations: false`) gets Windows 11's caption buttons, Maximize
  turning into Restore with every resize; Linux (`decorations: false`) gets
  GNOME's round close button and the screen's title in the middle (a route's
  `handle.title`). `?platform=` previews the others on mock IPC.
- The strip is `data-tauri-drag-region="deep"`: it drags the window and
  double-clicks to maximize, and Tauri's drag script leaves out buttons,
  links and other controls, so nothing in it needs its own exception. The
  window permissions it calls are in `tauri.conf.json`'s capability
  (`allow-minimize`, `allow-toggle-maximize`, `allow-close`,
  `allow-start-dragging`, `allow-internal-toggle-maximize`,
  `allow-set-always-on-top`; `is-maximized` comes with `core:window:default`).
  Close hides the main window to the tray (`lib.rs`); minimizing it during a
  recording opens the minibar.
- **Keep on top** is the pin in the strip, on every screen of the main window
  so a pinned window can always be unpinned (the design draws it on the
  recording screen). It is new, so it keeps Zustand's own format under a new
  key, `protocol-keep-on-top`, and the shell applies it to the window at
  startup (`keepOnTop.ts`).
- "Back to meetings" shows on every screen but the meetings (a route's
  `handle.back`) and goes to `/`.

### Routes and screens

- `routes.tsx` is the route table of both windows and `lib/paths.ts` (in
  `lib` so that features can navigate too) names every path: `/` the meetings, `/meetings/:meetingId` a meeting, `/recording` the
  recording screen, `/settings` with an optional `?section=` (the old UI's
  section ids, which the tray still sends; it replaces the old
  `meetily-settings-*` sessionStorage keys), `/settings/:page` a page inside
  Settings (see Settings), and `/minibar` outside the shell.
  It is a data router (`createBrowserRouter`), for `handle` and
  `useMatches` now and `lazy` and `useBlocker` later. Native code knows
  `/settings`, `/settings?section=about` and `/minibar`: they keep resolving,
  or native changes with them.
- A screen renders `Screen`: its `<main>`, with its own h1 first (in
  `theme.text.screen`), and the
  `<footer>` under it, both siblings of the title bar's `<header>`, so every
  screen has the banner, main and contentinfo landmarks. The footer docks
  the recording bar (`RecordingBar`, laid out by `DockedBar`, both in
  `features/recording`: the ring, what is happening, Record or Stop) over the
  screen's own `bar`, the meeting's player (#113). The shell provides the
  bar through `RecordBarContext` (`components/screen/recordBar.ts`), so
  `Screen` imports no feature; a story or a test without the provider
  docks none. The recording bar shows on every screen while a recording
  starts, runs or is being saved, and idle (Record) only where the screen
  sets `recordBar`: Home and the recording screen. The status
  line of model downloads (#117) goes in the same footer on every screen;
  with nothing in it, the footer is `:empty` and hidden from the eye and
  from screen readers.
- A screen arrives with a fade and a 4 px rise over `base`; the screen it
  replaces leaves at once, so a click never waits for an exit.
- A screen opened by a navigation focuses its `<main>` (`tabIndex={-1}`,
  `preventScroll`): the control that navigated, such as Settings or Back to
  meetings, leaves with the old screen, and focus would fall to `<body>`.
  The first screen of the page (location key `default`) leaves focus alone.
- `/minibar` is the minibar window's whole UI (`features/recording/minibar`,
  The minibar below).

### Startup

- Until native code says whether first launch is done
  (`get_onboarding_status`, `src/api/onboarding.ts`) the main window shows
  "Checking setup…" with a spinner under the title bar; a failed read, or
  one still running after 8 s (`STARTUP_PATIENCE_MS`), offers Retry, as
  the old layout did.
  Then it shows first launch or the app.
- The gate also waits for the database (`databaseQuery`, `ensureDatabase`
  in `src/api/onboarding.ts`), so nothing reads meetings before it exists.
  On a new install native code holds no database (no `AppState`) until the
  UI sets one up, and without it every database command fails,
  `complete_onboarding` among them, so first launch could never finish,
  `BusyReason::Onboarding` would hold for good and no update would install.
  At every start `ensureDatabase` asks `check_first_launch`, which Protocol
  answers from whether `AppState` is managed rather than from the file, so
  a set-up that failed and left its file behind still reads as missing.
  With no database it imports Homebrew's on macOS, as the old app did, or
  calls `initialize_fresh_database`, which also migrates a Meetily database
  (`meeting_minutes.db`) left in the data folder. `check_default_legacy_database`
  is not called: importing that file copied it onto itself, which empties
  it on Linux and macOS. A failed set-up shows "Unable to set up the
  meetings database" with Retry, which joins a set-up still running
  (`cancelRefetch: false`). Native's `first-launch-detected` is not
  listened to, as in the old app: the gate's own check at start sees the
  same state.
- First launch (`features/onboarding`, the gate's `firstLaunch` phase, with
  "Welcome" in the Linux title bar) has two steps: the name
  (`useUserNameStore`, under the old key), then the downloads with the
  microphone check. Each step change is saved (`save_onboarding_status_cmd`),
  so a restart comes back to it. The downloads start as first launch opens
  and run one after another, Parakeet, Whisper Large V3 Turbo
  (`enablePostCall`) and the summary model
  `builtin_ai_get_recommended_model` picks, skipping an installed one; a
  failure moves on to the next, and its row offers Retry. The list is data
  (`firstLaunchDownloads`): #117 swaps in Whisper's Intel GPU version and
  adds Intel's NPU libraries there. The run belongs to the app's
  `QueryClient`, not the screen, so it goes on after Done, and a failure
  after Done shows as a toast; a download still queued when the window
  reloads is not started, and Settings offers it. Done calls
  `complete_onboarding` (the summary model and Parakeet, and which were
  downloaded), says the downloads continue if any is unfinished, and
  invalidates the status (`onboardingKeys.status()`), so the gate reads it
  again and lets the app in. A model is in use only after its download completed:
  native code activates Whisper on completion, and a meeting uses
  Parakeet and the summary model only once they are there.
- The microphone check asks for the microphone first
  (`microphoneAccessQuery`), so the system's prompt comes from a step that
  explains it, then previews it on the ring (`test` mode); the chip changes
  `preferred_mic_device`. "Test computer audio" runs the Audio Capture
  probe on macOS, which asks for that permission; on Windows and Linux the
  ring follows the output for up to 5 s (`LISTEN_MS`) and any level above
  silence counts. A refusal points to System Settings on macOS.
- Once first launch is done, a crash report the previous session left
  (`src/api/crashReport.ts`) opens as a sheet over the app: Send Report and
  Save ZIP save the ZIP through the save dialog (Send then opens a GitHub
  issue to attach it to), Ignore dismisses it. Closing the sheet without a
  choice leaves the report for the next launch; a failure says so in the
  sheet and keeps it open.
- In a release the webview's context menu is off in both windows, as in the
  old app.

### Tray

- The tray (`tray.rs`) talks to the main window by event only, never by a
  reload, which would drop a meeting still being saved and the queued
  post-call jobs (`src/api/tray.ts`). `tray-navigate` carries a path and the
  shell routes it, from startup on. Start Recording sends
  `request-recording-toggle` (the old UI's name) instead of writing
  sessionStorage `autoStartRecording` and reloading, which started a
  recording without asking whether first launch was done.
- The shell hears the start request only once first launch is done
  (`ShellCommands`), so a Start during first launch does nothing. Native code
  no longer shows "Starting Recording…" for it: the menu keeps Start until
  `start_recording` succeeds and updates it, so a refused or failed start
  leaves no stale item, and a second click sends the request again. The
  request runs the recording's start (Recording › Start), the same as Record
  and ⌘R; the tray's Stop, Pause and Resume stay native, and the window
  follows them by their events.

### Hotkeys

- `lib/hotkeys.ts` is the window's one keydown listener, attached when the
  module loads. A screen, or a part of one, registers with
  `useHotkey({code, mod, shift}, run)` while mounted; the shell registers its
  defaults with `level: 'app'`.
- `mod` is ⌘ on macOS and Ctrl elsewhere, the other one must be up, and so
  must Alt (AltGr on Windows is Ctrl and Alt). Keys are `KeyboardEvent.code`,
  the physical key, so Ctrl R is Ctrl R on a Russian layout too. Hints write
  them with `formatShortcut`.
- On the same keys a `screen` hotkey wins over an `app` one, and within a
  level the latest registration wins. The shell's are ⌘R (start a
  recording, or stop the one that runs: `toggleRecording`; nothing while one
  starts or is saved) and ⌘, (Settings); ⌘K is search's (#118). The
  recording screen adds ⌘1, ⌘2 and ⌘3 for Notes, Transcript and Summary
  while it records.
- A ⌘ hotkey works from a text field too, and always stops the browser's own
  action (Ctrl R would reload the page), even while it does not run: while a
  sheet is open (`role="dialog"`), or for a key held down. ⌘R is blocked even
  with no hotkey on it, so startup and first launch, before the shell
  registers its own, do not reload either. A bare key, such as
  Space, belongs to the focused control first (fields, buttons, links, tabs,
  switches, menu items: Space presses them) and to an open sheet; it runs only
  when focus is on none of them.
- **Space** belongs to the screen in front, and nothing registers it
  app-wide: on the recording screen it pauses and resumes the recording (the
  ring, the minibar's `Pause (Space)`); on a meeting it plays and pauses that
  meeting's audio, also while a recording runs elsewhere. So it never pauses
  a recording the user cannot see, and the old player's Space keeps working.
  The meeting's ← and → stay on the scrubber's focus.

## Styling

- Values come from the theme only: `theme.colors`, `text`, `fonts`,
  `fontWeights`, `radii`, `space`, `sizes`, `shadows`, `motion`
  (`src/styles/theme.ts`; Motion below).
  A literal color, size or radius in a component is a missing token; add it to
  both themes. Foundations/Tokens in Storybook shows them all.
- Text styles are objects, used whole: `${({theme}) => theme.text.body};`.
- Components never branch on light or dark; both themes have the same keys.
- Props meant only for styling are transient: `$selected`, `$tone`, so they
  never reach the DOM.
- Values that change every frame (audio levels, the ring, a playhead, a
  progress that ticks) never go through styled props: each new value would
  generate a new class. Write them through a ref (`el.style.transform`), a CSS
  variable on a ref (`el.style.setProperty('--level', …)`), or a canvas.
- Icons are Phosphor (`@phosphor-icons/react`), Regular weight, 16 px by
  default (`ICON_DEFAULTS`). Import the `*Icon` names (`MicrophoneIcon`); the
  bare names are deprecated, and `Record` would shadow TypeScript's type.
- Shortcut hints use `formatShortcut('K')`: `⌘K` on macOS, `Ctrl K` elsewhere.
  `platform` comes from the user agent; `?platform=macos|windows|linux` previews
  another platform on mock IPC.
- `index.html` gets no `<style>` element. Tauri gives inline styles in the
  HTML a nonce, and a nonce in `style-src` turns off the `'unsafe-inline'`
  that styled-components needs. Its boot script, which sets `color-scheme`
  before the bundle runs, repeats the theme key and values of `themeMode.ts`;
  `themeBoot.test.ts` runs it against them.

## Primitives

`components/ui` holds the building blocks every screen uses, each with Light
and Dark stories. Behaviour and accessibility come from Radix (Dialog, Select,
DropdownMenu, RadioGroup, Switch, Tooltip) or from native elements; the look from the
theme; the motion from the Motion section.

- `Button` (filled, secondary, ghost; `sm` 28 px in rows, `md` 30 px in
  footers; `pending` while what it started runs, see Motion) and
  `IconButton`, whose required `label` is its accessible name
  and its tooltip. `Kbd` shows a shortcut on the window, a grey field or a
  filled button.
- `SegmentedControl`, and `Tabs` with `TabList` and `TabPanels` (see Motion).
  `Crossfade` with `CrossfadeView` swaps any two views in one place the way
  `TabPanels` swaps panels: one grid cell, a `base` veil (see Motion), and
  the leaving view `inert` while it is covered.
- `Switch`, `Select`, `TextField` and `TextArea`. `SettingsGroup`,
  `SettingsRow` and `SettingsNavRow` lay out a settings card; a control in a
  row without a name of its own (`label`, `aria-label`, `aria-labelledby`)
  is named by the row's label and described by its description, which may
  be a `StatusLine` for a status that changes (an update's). A control too
  wide to leave the text 160 px (Theme's three segments) drops to its own
  line rather than squeezing the label to a word per line. A focused
  field draws a 2 px stroke in the text colour on its edge
  (`fieldFocusRing`), so focus differs from hover's `muted` border. The
  stroke is one outline over the border, never a border plus a spread
  shadow: the two snap to device pixels separately, and at a fractional
  display scale (175 %) one side comes out thinner. An
  external `SettingsNavRow` says "(opens in browser)" to screen readers.
  `SettingsRadioGroup` with `SettingsRadioRow` is one choice among rows
  (Radix RadioGroup: arrow keys move and choose, Tab enters at the chosen
  row), titled like a group; a value no row has leaves every row unchosen.
  The ring takes the text colour and the dot fades in, scaling up inside
  `MOTION_OK`.
- Settings search needs no list of settings: under a `SettingsSearchScope`
  each `SettingsRow`, `SettingsNavRow` and `SettingsRadioRow` checks its own
  label, string description, badge and value against every word of the
  query (`settingsSearch.ts`). A row that does not match renders nothing,
  so its control remounts when it shows again; a group with no row left
  (`[data-settings-row]`) hides by CSS `:has()`, titled with the scope
  before its own title ("AI · Summaries") and without its note. The card's
  hairlines skip the empty wrapper a hidden row leaves (a `Collapse`).
  `onMatches` gives the count, for "Nothing matches". Filtering does not
  animate, as on Home.
- `VisuallyHidden` holds text only assistive technology reads.
- Menu and select rows keep the design's faint highlight; the keyboard's row
  also gets an inset `muted` ring on `:focus-visible` (`keyboardRowRing`),
  which the pointer never shows. The notes editor's menus do the same.
- `Menu` with `MenuItem`, `MenuCheckboxItem`, `MenuRadioGroup` and
  `MenuRadioItem`, `MenuGroup`, `MenuSub` and `MenuSeparator`.
- `Sheet`: a dialog over the dimmed window, opened through `open`. On close
  it returns focus to the control that opened it; for a menu item, which
  has gone with its menu, that is the menu's button. Its scrim starts under
  the title strip, which stays live (`pointer-events: auto` against Radix's
  lock on `<body>`), and a press there does not close the sheet, so the
  window still moves, minimizes and closes on Windows and Linux.
- `Tooltip` shares its open delay through `TooltipProvider`.
- Toasts: `toast('Recording cancelled')`, or with a tone,
  `toast.success | info | warning | error | loading(title, {description,
  action: {label, onClick}, duration, id})` from `toastStore.ts`, callable
  from anywhere, a mutation's callback or an event handler outside React;
  `toast.dismiss(id?)` closes one or all. The window's one `Toaster`
  (`Toast.tsx`) draws them under the title strip, newest on top, at most
  three (a fourth closes the oldest timed one; a persistent one, such as
  "Copy notes", closes only for another persistent one), above an open
  sheet and usable over it. The design draws no toast: it takes the Home banner's look, an icon
  for the tone (none is red, which is the recording's), a medium title, a
  muted line that wraps anywhere (a hash fits), one small action and the
  close button. Radix's toast gives the behaviour: the time on screen
  (5 s, `Infinity` for `loading` or to wait for the user, 30 s for a
  warning that must not be missed) stops under the pointer, on focus and
  while the window is in the background; Escape closes the focused toast,
  F8 reaches them, errors and warnings interrupt screen readers and the
  rest waits its turn. An action closes its toast; give it `altText` when
  the same can be done elsewhere. Showing a toast again with its id
  replaces it where it stands (a loading toast and its outcome); the
  Toaster announces the new text, since Radix announces a toast only when
  it appears. A mouse drag never dismisses one.
- `UiProviders` (`components/ui/`) is what the primitives expect above
  them besides the theme: `MotionProvider`, the icon defaults,
  `TooltipProvider` and the `Toaster`. App, Storybook's decorator and the
  tests' `renderUi` (`src/test/`) mount it.
- `StatusLine`, whose `busy` status turns a spinner before its text, and
  `ProgressBar`. The bar scales its fill by transform from an inline
  style, so a ticking value makes no new class. `Spinner` marks a wait of
  unknown length (see Motion).
- `Collapse` holds what a disclosure shows and hides (see Motion); the
  button that toggles it sets `aria-expanded`.

## Motion

Motion shows what changed: where a selection went, what arrived, what left,
and that a wait is still running. It is never decoration. CSS transitions
carry state feedback (hover, press, focus); motion (`motion/react`) carries
enter and exit, indicators and springs.

- Tokens live in `src/styles/motion.ts`: durations `fast` (120 ms: hover,
  press, focus), `base` (200 ms: most changes of state, the theme crossfade)
  and `slow` (320 ms: large surfaces); easings `standard`, `enter` and
  `exit`; springs `snappy` (indicators) and `gentle` (sheets, panels); and
  `spinner`: one `turn` (900 ms, linear) and the `delay` (400 ms) before a
  delayed spinner shows. CSS reads `theme.motion.duration.*`,
  `theme.motion.easing.*` and `theme.motion.spinner.*`; motion/react
  reads `tween(duration, easing)` and `springs.*`. A literal duration or curve
  in a component is a missing token. Foundations/Tokens plays the durations,
  easings and springs side by side; UI/Spinner shows the spinner's.
- Only `transform` and `opacity` animate, plus colours in state feedback and
  the theme change. Width, height, top, left and margin never animate: each
  frame would lay the window out again. Something that has to grow appears
  with a small rise under a veil, and the layout moves once. The one exception
  is `Collapse`, a disclosure's content ("What's included?", advanced
  settings): it grows its height under a clip, because what follows it has
  to slide rather than jump, and its text must not fade, since text that
  ends an opacity animation is rasterized again and visibly blinks. It is a
  short block in a sheet or a settings card, so laying it out each frame
  is cheap.
- Text never fades itself. Under an opacity below 1 Chromium draws text
  without subpixel antialiasing and draws it again when the fade ends, a
  visible blink. So content that holds text keeps its 4 px rise
  (transform) and is revealed by a veil (`components/ui/Veil.tsx`): a layer
  in the colour behind it that fades out over it, the only composited
  thing; under AnimatePresence the veil covers a leaving element again
  before it goes, or the element goes at once. The veil's colour is
  `--surface`, which a surface sets on the element inside it whose content
  swaps (the settings card, the processing strip's content, first launch's
  download list and microphone card); the window's background otherwise.
  `statusSwap` (`styles/motion.ts`) is the motion of a status change. Overlays with a
  surface of their own (sheets, menus, select lists, tooltips, toasts, the
  transcript's Latest button) keep their fade, and so does the ring's
  source button, whose own background changes with its content.
- Animated elements are `m.*` (`import * as m from 'motion/react-m'`) under
  `MotionProvider` (through `UiProviders`). It loads `domAnimation`
  (`components/ui/motionFeatures.ts`) as its own chunk after the first
  render; until then an `m` element keeps the values it mounted with and
  catches up when the chunk arrives. Its `strict` mode rejects the full
  `motion.*`. Import nothing from
  motion's imperative API (`animate()`, `useAnimate`): it puts the engine back
  into the first chunk. Layout animations (`layout`, `layoutId`) need
  `domMax`, which is not loaded: an indicator moves by transform instead.
- Segmented controls and tabs share one track (`SegmentedControl.tsx` in
  `components/ui`), whose motion follows ddoemonn's
  [Segmented Control](https://21st.dev/@ddoemonn/components/segmented-control)
  on 21st.dev, the owner's pick: equal segments, a thumb moved by transform
  on `springs.snappy`, and the thumb as the only filled shape. Hover and press
  change only the text colour; keyboard focus draws an outline.
  `SegmentedControl` is a radio group on the window (the theme);
  `Tabs` with `TabList` and `TabPanels` is a tab list on a grey track over
  its views (the meeting's Notes · Transcript · Summary).
- Radix gives the overlays their behaviour; motion animates them. Sheet,
  Menu and Tooltip hold their open state, and AnimatePresence keeps their
  `forceMount`ed content until the exit has played (Radix's guide to
  JavaScript animation). Select cannot: closed, Radix keeps its items in a
  detached fragment, which shows the current label and selects by typing, so
  its list stays forced in for `fast` after it closes.
- Waits always move, though the window otherwise moves little: a wait of
  unknown length shows a `Spinner`, a wait whose share is known shows how
  far it has got (a `ProgressBar`, or a percent that climbs), and static
  text alone never marks a wait, since it looks frozen. The spinner is
  Phosphor's CircleNotch turning in the current colour, sized to the text
  (`1em`) and hidden from screen readers: the text beside it, or
  `aria-busy` on what waits, says what the wait is. It is essential motion
  and keeps turning under reduced motion. Where waits show:
  - `StatusLine` turns one before a `busy` status, such as "Checking for
    updates…" or the startup gate's "Checking setup…".
  - A spinner standing in for something that usually ends at once is
    `delayed`: it fades in only after `spinner.delay`, so a fast load or
    action shows nothing rather than a flash. The notes editor's fallback,
    while its BlockNote chunk loads, turns one on the notes' first line.
  - `Button`'s `pending` disables the button and sets `aria-busy` at once;
    if what the click started runs past `spinner.delay`, the label turns
    transparent in one step (never fading), keeping the button's width, and
    a delayed spinner fades in over it until the action ends. So Ignore,
    which usually ends at once, keeps its label. The crash report sheet's
    Send Report, Save ZIP and Ignore use it.
- What animates and how:
  - Screens and first launch's steps arrive with a 4 px rise under a veil
    over `base`; the one they replace goes at once.
  - Home's folder chips: the selected chip's outline is a thumb that
    slides to the chip chosen by transform on `springs.snappy`.
  - Menus draw the border and shadow on a surface that never scrolls; the
    rows scroll inside it.
  - Tabs and segmented controls: the thumb slides; the panel below swaps
    through the veil over `base` (`Crossfade`: the old view is covered, the
    new one revealed), without sliding. Other views that replace each other
    in one place use `Crossfade` too.
  - Sheets and dialogs: in from their edge by `y` on `springs.gentle`, the
    scrim fading over `base`; out with `tween('base', 'exit')`. A sheet hangs
    under the window's header, so it arrives from above.
  - Toasts hang there too and move the same way, from above and back up. A
    toast replaced where it stands swaps its content as a status change
    does.
  - Menus, select lists and tooltips: opacity and a scale from `SCALE_FROM`
    (0.96), with `transform-origin` on the side of their anchor, over
    `fast`. Inside a menu or a select list one highlight slides between the
    items on `springs.snappy` (`SlidingHighlight`); it stays on the last
    item while the pointer crosses a separator or a group label and lands
    on the next item past it rather than sliding across, and fades when the pointer
    leaves the list or rests on a disabled item, where Enter would do
    nothing.
  - Lists: a new row rises 4 px under a veil over `base`, a removed row
    goes at once; no stagger, and no reordering animation (it needs layout).
    Home's banners and the meeting's processing strip and steps arrive the
    same way.
  - Disclosures: `Collapse` grows from nothing to its content's height over
    `base` and shrinks back the same way, at full opacity throughout; its
    button's caret turns over `fast`. The clip holds only while the height
    moves, so a focus ring at the content's edge shows once it is open.
  - Status changes (a status line, a badge, a count): `AnimatePresence
    mode="wait"` with the old value leaving and the new one arriving, 4 px
    of `y` (`statusSwap`) under a veil over `fast`, as the shell's update
    status does. The key
    names the meaning, not the text: re-key when the meaning changes, never
    on every value; a value inside one meaning (a download's percent, a
    count) updates in place. That value also stays outside the
    `role="status"` live region, beside it, so screen readers announce a
    change of meaning and not every tick; `StatusLine` does both.
  - Hover, press, focus: CSS on the element. Colour and background change
    over `fast`; a button's press scales it to `SCALE_FROM` inside
    `MOTION_OK`; the focus outline appears at once. Segmented options take neither a fill nor
    a scale.
  - Every theme change crossfades: `setMode` goes through
    `changeThemeSmoothly` (`styles/themeTransition.ts` says how and why), and
    so do an OS switch in system mode and a change made in the other window.
    Callers just call `setMode`. With View Transitions the window crossfades
    over `base`, and clicks made during it are lost; without them the theme
    switches at once. Colours never transition one by one.
  - Values that change every frame (audio levels, the ring) stay outside
    motion and React; see Styling.
- Reduced motion: `MotionProvider` sets `reducedMotion="user"`, so transform
  and size animations (`Collapse`'s height) jump to their end while opacity
  still fades. The spinner's turn stays outside `MOTION_OK`. CSS movement goes
  inside `MOTION_OK` (`@media (prefers-reduced-motion: no-preference)`);
  colour and opacity transitions stay outside it, and so does the theme
  crossfade, which moves nothing. motion reads the setting when an element
  mounts: a change while the window is open reaches elements mounted after it,
  and all of them after a reload; CSS follows at once. The `ReducedMotion`
  story of `SegmentedControl` shows it, and Orca's browser emulates the setting
  with `orca set media --reduced-motion reduce`.
- Tests run with `MotionGlobalConfig.skipAnimations` (`src/test/setup.ts`), so
  every animation ends at once; motion writes styles on its next frame, so
  assert them inside `waitFor`.

## Native data

- Every call goes through `command()` in `src/api/core.ts`. It rejects with a
  `CommandError` whose `message` is the Rust error string and whose `detail` is
  the raw value, for commands that reject with an enum.
- A domain file (`src/api/updater.ts`, or `features/<x>/api/…` when one feature
  owns it) holds the payload types mirroring the Rust ones, one wrapper per
  command, the event names, the query keys and the `queryOptions`. No React in
  it.
- Query keys are a factory per domain, rooted at the domain name:

  ```ts
  export const meetingKeys = {
      all: ['meetings'] as const,
      lists: () => [...meetingKeys.all, 'list'] as const,
      detail: (id: string) => [...meetingKeys.all, 'detail', id] as const,
  }
  ```

  Invalidate by prefix (`meetingKeys.all`); never write a key by hand.
- Native data lives in Query: what the database, the recorder or the updater
  owns is read with `useQuery` and changed with `useMutation`, never copied into
  a store. Zustand holds client state only: UI choices, drafts, the theme mode.
  A store that must survive a restart uses `persist`. A key PARITY.md marks
  **Keep reading** keeps its name and its old value format. If a Zustand store
  holds it, the store gets a `PersistStorage` of its own, as
  `bareStringStorage` in `src/styles/themeMode.ts` does, never Zustand's
  default `{state, version}` JSON. The default cannot read an old bare string
  or JSON shape, so the store would start from its default and overwrite the
  user's value on the first write. The default format is for new keys only.
  A per-meeting key family (`summaryLanguageFallback:<meetingId>`,
  `detectedSummaryLanguageFallback:<meetingId>`,
  `meetily-speaker-edits:<meetingId>`) belongs to no store: the feature's api
  file reads and writes each key with `localStorage` directly, under the old
  name and format, since `persist` keeps a whole store under one key.
- The user's preferences that several screens read sit in
  `src/api/preferences.ts`: the name, the meeting language, the automatic
  summary and the summary language are one small store each, under the old
  keys and formats; the summary model is a query. `usePreferencesSync`
  (mounted in `App`) reads a change made in the other window again and sends
  the meeting language to native at startup and on every change, since native
  keeps it in memory only. Pin a summary language with
  `pinSummaryLanguage`, which keeps it on the recent list.
- The recording preferences (`src/api/devices.ts`) are one native object that
  `set_recording_preferences` replaces whole. Change them only with
  `updateRecordingPreferencesMutation()`: its updates share a mutation scope,
  so they run one at a time, and each reads the stored object again before
  writing it, so fields no screen shows and changes made at once all
  survive; it keeps the legacy single-app fields on the first chosen app.
- The updater's commands (`src/api/updater.ts`) each answer with a snapshot,
  and the same snapshot arrives as `updater-status`, which alone writes the
  cached status: a caller ignores the reply. Download runs only on a click and
  Restart and update only on another. `installUpdate()` rejects when nothing
  is ready or work must not be interrupted; `installRefusal(error)` reads
  which from the rejection. A failed install resolves, its error in the
  snapshot. What the app says about updates (busy reasons, errors, notes,
  links) is in `src/lib/updateText.ts`, shared by Settings › Updates and the
  Home banner. The mock (`src/mocks/updater.ts`) is an installed copy: a check
  finds `mockState.updateRelease` and a download moves in ten steps.
- Data that native code pushes whole by event gets `staleTime: Infinity`, and
  only the event writes it (see Events). Other data keeps the default
  `staleTime` and is invalidated after the mutations that change it.
- Long work that only the WebView sees, saving a meeting after its recording
  stopped (`recordingSave`) and the post-call pipeline between its native
  steps (`postCall`), reports to the updater with
  `updater_set_ui_activity({activities})`, as `markUiActivity` and
  `UpdaterActivityReporter` did in the old UI (`162e8be`). Each call replaces
  the whole set, and native code drops it 150 s after the last call
  (`UI_LEASE`, the UI activity lease in `src-tauri/src/updater/busy.rs`), so
  the reporter sends a non-empty set again every minute while the work runs
  and an empty one when it ends. Otherwise an update can restart the app in
  the middle of the work. A new activity name needs a native `UiActivity`
  variant first: an unknown name fails the whole call, so the lease stops
  being renewed for the others. Long work a native command does registers
  natively and needs no lease: it holds `updater::busy::hold(…)` while it runs
  (model downloads), or `busy::current()` reads it through its owner's getter
  (summaries, through `active_summary_count`). A command that does neither
  gets that added in Rust, never a UI lease: `ask_live_assistant` ("Summarize
  so far") holds `BusyReason::Summary` while it answers, since an answer can
  outlive Stop; `ask_person` still holds nothing.

## Recording state other screens read

Two small stores in `src/api` let screens outside the recording feature
follow it without importing it. The recording feature is the only writer of
both: its session store mirrors its phase into `recordingPhase`, and its
post-call runner writes `postCallJobs` (Recording below).

- `recordingPhase.ts`: where the main window's recording is: `idle`,
  `starting`, `recording`, `paused` or `finishing` (Stop pressed, the
  meeting being saved). `useRecordingPhase()` reads it, `useRecordingBusy()`
  says whether it is anything but idle (Settings locks the meeting language
  then), `recordingPhase.get()` reads it outside React. It changes with the
  recording's own events, before the updater's busy snapshot would.
- `postCall.ts`: the pass after a recording is saved (retranscription,
  diarization, the automatic summary), one job per meeting:
  `usePostCallJob(meetingId)` is the meeting's job while it is queued, runs
  or failed, and null once it has ended; `usePostCallBusy()` is whether any
  job is queued or runs. The recording's runner, mounted
  once by the shell above navigation, writes it (`postCallJobs`); a screen
  asks it to cancel, retry or skip a step through `postCallControls`, never
  by writing a job. When a step ends the runner invalidates the meeting's
  queries. The file also holds the retranscription and
  diarization commands and events, which Enhance transcript (#119) and
  "N speakers · change" (#113) call, and `RETRANSCRIPTION_BANDS`: native's
  percent is not linear in time, and only its chunks' band (25 to 80) has a
  pace, so the time left is measured there.
  `features/meetings/components/processing` draws a job:
  `ProcessingStatus` (the strip under a meeting's header),
  `ProcessingSteps` (the steps where the summary will be) and
  `ProcessingLine` (Home's row); each renders nothing without a job.
  `progress.ts` beside them has the words, the share of the pass done and
  the time left.

## Events

Native code emits with `app.emit(name, payload)`, or `emit_to(label, …)` for
one window. To use an event:

1. Declare its name in the domain file that owns it, typed with its payload:

   ```ts
   export const UPDATER_STATUS_EVENT = 'updater-status' as NativeEvent<UpdaterSnapshot>
   ```

   `src/api/events.ts` keeps no list of events, so it never imports from a
   feature, and a bare string does not type-check where an event is expected.
2. Subscribe with `useNativeEvent(EVENT, handler)`. It registers once, always
   calls the latest handler, and removes a listener that finishes registering
   after an unmount. Without a `target`, a listener also hears events native
   code sent to the other window; an event meant for one window is heard with
   `{target: getCurrentWindow().label}`.
3. When the event carries the whole value, keep its query with
   `useEventQuerySync` (it takes the same `target`) instead of refetching:

   ```ts
   export function useUpdaterStatusSync() {
       useEventQuerySync(UPDATER_STATUS_EVENT, updaterStatusQuery.queryKey)
   }
   ```

   It cancels a read still in flight before it writes the payload with
   `setQueryData`: a reply and an event reach the webview on separate
   channels in no fixed order, so the reply may hold an older value and land
   over the event's. Once the listener is registered it reads the query again,
   because events sent before that went nowhere. From then on the event is the
   only writer of that query: no `setQueryData` from a mutation's reply and no
   `invalidateQueries` for it, since either can bring back an older value.
4. When the event only says that something changed, `invalidateQueries` the
   keys it affects in a `useNativeEvent` handler.

A sync hook lives in its domain file (`useUpdaterStatusSync` in
`src/api/updater.ts`), never in `app/`, which features do not import. Mount it
once, in the layout of the screens that read the data, or in `App` when every
window needs it; a story or test that renders them without App mounts it
itself. Values that arrive many times a second (audio
levels) skip Query and React state; see Styling and the next section.

### Models and permissions

- `src/api/models.ts` holds the speech models (Parakeet live, Whisper after
  meetings) and the built-in summary models: their lists, the downloads and
  retries, the recommended summary model, and the download events. Native
  code owns every download and holds the `modelDownload` busy reason while
  one runs; a download command resolves only when its download ends.
- A download's progress, its Whisper activation and its last failure come
  only by event. `useModelDownloadSync` (`src/api/modelDownloadSync.ts`,
  mounted by the shell in front of the startup gate, so first launch's
  downloads are heard and keep being heard after it, and by stories of a
  screen that downloads) writes them into `downloadsQuery`, which nothing
  fetches, and reads a model's list again when its download ends, clearing
  the download only once the list has answered. A second call for a running
  download is refused, and native code sends the refusal as an error event
  too (`isAlreadyDownloading`); the sync ignores it, since the first
  download goes on. `modelState(status, download)` folds a list's status and the download into
  what a screen shows: `ready` only after the completion event, which comes
  after verification, so a percent stays below 100 until then.
- Native code activates a model after its download, never the UI:
  `downloadWhisperModel(POST_CALL_WHISPER_MODEL, {enablePostCall: true})`
  saves Whisper as the after-meeting model before it resolves, which
  survives a reload of the window; it needs the database.
- `src/api/speech.ts` is the transcript config: the live model
  (`parakeet` or `localWhisper`), the after-meeting model (`live` follows
  the live one) and the words to recognize, read with Query and saved with
  its mutations. `useSpeechConfigSync`, mounted by the shell beside
  `useModelDownloadSync`, reads the models again when native code changes
  them itself (`transcript-config-changed`,
  `post-call-transcript-config-changed`). A recording's start, the
  post-call pass and Enhance transcript read it there.
  `src/api/labs.ts` is Labs: Waveform scrubbing and Clean transcript live
  only in `meetily-labs-v1` (`useLab`, `setLab`), which keeps every field
  the old app wrote; the Whisper silence guard and Parakeet on the GPU are
  native switches read as queries. Voice profiles, the third native
  switch, is in `src/api/people.ts` (#118). `lib/cleanTranscript.ts` is
  what Clean transcript shows. `storedValue` (`lib/storage.ts`) keeps a
  value under an old key in its old format, for these and the preferences.
- `src/api/permissions.ts` asks for the microphone and, on macOS, Audio
  Capture, reads the Audio Capture record and opens the privacy panes (macOS
  only). A microphone is usable when the device list has an input. The
  Audio Capture probe (`systemAudioProbeQuery`) may prompt and listens for
  5 s, so it runs only on a click (`refetch()`); its answer holds for the
  session and stands in for a record that lags (`systemAudioAllowed`).
  `microphoneAccessQuery` asks for the microphone once per session; its
  `refetch()` asks again.

## Audio levels, the ring and the meters

- Native code pushes two level events, declared in `src/api/audio.ts`:
  `recording-audio-levels`, one sample per source (`mic`, `system`) and audio
  chunk during a recording, about 25 a second per source; and `audio-levels`,
  every previewed device about 12 times a second between
  `start_audio_level_monitoring` and `stop_audio_level_monitoring`.
  `levelOf(rms, peak)` turns a sample into 0 to 1 on the old meters' decibel
  scale (-50 dB empty, -16 dB full).
- A screen says what to follow with a `LevelFeed`, plain data:
  `{kind: 'recording', source: 'mic' | 'system' | 'both'}` (`both` is the
  louder source) or `{kind: 'device', type: 'input' | 'output', device?,
  gain?}`. As in the old preview, a device matches when either name contains
  the other (a stored device carries a ` (input)` or ` (output)` suffix),
  otherwise the loudest device of the type counts, and `gain` (the volume
  slider beside a preview meter) applies before the decibels, so moving the
  slider moves the meter at once.
  `useAudioLevel(feed, onLevel)` hands each level to a callback that writes a
  ref or a canvas, never state; `subscribeAudioLevel` is the same without
  React, on `subscribeNative` (`src/api/events.ts`). Each subscriber has
  its own listener: Tauri sends an event to a webview once, with every
  listener's id, so more listeners cost only their callbacks.
  `useAudioLevelMonitoring(deviceNames)` runs the device preview while mounted
  and stops it on unmount; its starts and stops wait for each other, because
  native's start stops the old preview and waits before it opens the devices,
  so a stop arriving meanwhile would be undone.
- `components/ring` holds what draws them. `Ring` is the design's WebGL ring
  in four modes: `rec` follows the level, `test` (the mic test) exaggerates
  it, `idle` is greyed and slow and does not listen, `paused` is flat and
  grey. `LevelMeter` is the five bars;
  `SourceMeter` is the mute toggle of the recording bar and the minibar, with
  the bars or, muted, "Muted" on an inverted fill. Its name comes from its
  content, so it holds the visible "Muted" (WCAG 2.5.3): "Mute microphone"
  while on, "Muted microphone" while muted, with `aria-pressed`; its
  Tooltip says what a click does. A `warning` (`'loud'` or `'quiet'`) puts a
  warning icon in the source's place, outlines the button in the text colour
  (no hue: red is the recording's), adds "too loud" or "low audio" to its
  name, and its Tooltip says what to do; the minibar turns the Tooltip off
  (`tooltip={false}`), since its window would clip it.
  `useSystemAudioWarning(active)`
  (`levelAdvice.ts`) computes it for computer audio from
  `recording-audio-levels`, as docs/SYSTEM_AUDIO_LEVEL_ADVICE.md describes:
  Too loud after 750 ms of limiter hits no more than 250 ms apart, cleared
  1.5 s after the last; Low audio after 5 s of RMS between -80 and -45 dBFS
  with peaks under -30 dBFS, cleared after 1 s without samples. The
  microphone gets no advice. The button around the ring (pause) and the
  native mute calls belong to the screens.
- The ring's cost is bounded in `ringLoop.ts`: one requestAnimationFrame loop
  per ring, running only while the canvas is on screen, the document is
  visible and motion is allowed; under reduced motion it draws one frame and
  draws it again when a prop or the theme changes. The canvas is the CSS
  size times the device pixel ratio, capped at 2, on a context without
  antialiasing, depth or stencil that asks for the low-power GPU. The shader
  runs in highp where the GPU has it, and its clock wraps every 40π s, the
  period on which every time term repeats, so on a GPU with only a 16-bit
  mediump its error stays under 1/16 s instead of growing with the
  recording. Without
  WebGL, or while the context is lost, `StaticRing` shows a still gradient
  ring greyed per mode. Under reduced motion the ring holds the logo's frame
  in its mode's grey; the meters still show the level, without easing.
- The meters write `transform: scaleY(…)` on their bars at each sample and
  let a CSS transition smooth it; they fall to rest 300 ms after the last
  sample, since native stops sending when a recording stops. The ring's
  loop reads the level as 0 after the same 300 ms, and `Ring` resets it
  when its feed ends.
- The mock fakes both events (`src/mocks/audio.ts`): outside tests a fake
  conversation emits `recording-audio-levels` from the start, and the preview
  commands emit `audio-levels` for the devices asked for.
  `mockState.audio.level` holds both sources at one level instead (the
  stories' level slider). Tests emit the samples they need.

## Recording

`features/recording` owns a recording from Record to the saved meeting and
the pass after it. The shell mounts `RecordingRuntime` once (in
`ShellCommands`, after first launch), so every screen of the main window
hears native's recording events and a Stop from the tray, the minibar or a
quit is saved whatever screen is open. The minibar window mounts none of it.

- **Session** (`store/session.ts`): one Zustand store, client state only:
  the phase (`idle`, `starting`, `recording`, `paused`, `finishing`), what a
  start or a save is doing (`step`), the timer (`clock`: seconds at a
  moment, so it renders without native calls and stops at the take's length
  when capture ends), the mutes, the crash copy's id (`recoveryId`,
  `meeting-<ms>`), the title and whether the user typed it, the folder the
  meeting will be filed in, the live lines and the notes. The phase is
  mirrored into `recordingPhase`. Native is the truth: the phase moves on
  `recording-started`, `-paused`, `-resumed`, `-stopped` and `-error`, and a
  pause or resume reads `get_recording_state` again for the timer.
- **Start** (`store/start.ts`), from Record, ⌘R and the tray alike, in
  PARITY.md's order: `check_transcription_runtime`; the live model loaded
  (Parakeet unless Settings chose Whisper, `api_get_transcript_config`); an
  automatic title (`lib/titles.ts`, after the folder when one is picked);
  then `start_recording_with_devices_and_meeting` with the preferred devices.
  A start opens the recording screen at once and says what it waits for. A
  missing, downloading or damaged model, a runtime that cannot load, or a
  device that cannot open ends in a toast and idle; the model ones offer
  Speech models.
- **A reload during a recording** (`syncWithNative`): `is_recording`,
  `get_recording_state`, the name and `get_transcript_history` bring the
  timer, mutes, title and lines back; the notes come from `af-live-notes`;
  the crash copy is found again by its title, or a new one is made. When
  `is_recording` itself fails the bar says recording is unavailable; when
  only `get_recording_state` fails the session still joins, keeping the
  timer, pause and mutes it last knew.
- **Live lines** (`transcript-update`) are kept in order by start time, once
  per sequence id, with this recording's speaker names replayed
  (`lib/speakerEdits.ts`, `meetily-speaker-edits:<recoveryId>`), and each is
  copied into the crash copy. Renaming a voice in the Transcript view names
  it on every line, present and to come; "You" is never renamed.
- **Notes** live in the session (every edit) and in `af-live-notes`
  (written at most every 500 ms, and when the window hides). The editor
  mounts from the session, keyed by the recording, so a view switch never
  mounts it from an older copy; from Stop on it is read-only, so the notes
  saved are the ones on screen. When they do not reach a meeting (the notes
  save failed, or the meeting was not saved at all, since recovery brings
  back only the transcript) a toast waits to copy them.
- **Stop and save** (`store/save.ts`) follows PARITY.md › Stop and save
  order: `stop_recording` with the save path, then on
  `recording-stop-complete` a take under 10 s is discarded (folder and crash
  copy too); otherwise `get_transcription_status` is polled every 500 ms for
  up to 60 s, late lines get 4 s, and only a completed wait saves: the
  transcript (`saveTranscript`), the folder, the notes, the pinned summary
  language or the detected one (`store/summaryLanguage.ts`), the crash copy
  marked saved. The answer goes to `recording_save_finished` before anything
  refreshes; when it says Protocol is not quitting, the meeting opens at
  `/meetings/:id` and its pass is queued (the old `source=recording` is not
  needed: the meeting screen reads the job). A timeout or a failed poll
  saves nothing and answers `notSaved`; the crash copy stays for recovery.
  `SAVE_TIMING` holds the waits (tests shorten them).
- **Post-call pass** (`store/postCallRunner.ts`): retranscription when the
  audio was saved (with the post-call model: `api_get_post_call_transcript_config`,
  else the live one, else any downloaded, Parakeet first), then speakers
  when a speaker engine is installed, then the automatic summary when it is
  on. One meeting at a time; each step waits for the one before. A failed
  step waits for Retry or Skip; a skipped one leaves the list. Cancel stops
  native between chunks, and reaches a summary that is still starting. A
  retranscription past 30 minutes and a summary past 60 are cancelled and
  fail with Retry (`RUNNER_TIMING` gives each limit its reason). Its
  listeners are registered (`listenNative`, awaited) before the start,
  since a missing audio file fails at once; after a cancel, an error or the
  limit the step waits until `is_retranscription_in_progress_command` says
  native let go of the model, so the next meeting or a Retry does not fail
  with "Retranscription already in progress". That wait ends after 2
  minutes: the step's error stands (a completed step fails), and a pass
  that native then rejects fails with Retry rather than holding the queue
  and the updater for good. A second Cancel while cancelling changes
  nothing. Deleting a meeting cancels its pass first.
- **Recovery** (`api/recovery.ts`, `store/recover.ts`, `RecoverySheet`):
  IndexedDB `MeetilyRecoveryDB` v1 as the old UI wrote it. A recording's
  record is made at its start; every line is added. Once per page load the
  sheet offers unsaved meetings updated within 7 days and more than 2 s ago
  that have lines (one without lines has nothing to save, so it is not
  offered); Recover saves it with audio rebuilt from the checkpoints when
  there are some, Delete asks first; the rebuild and save report
  `recordingSave` to the updater. Old copies are pruned (7 days, saved
  ones after a day), never while recording.
- **The bar** (`RecordingBar`): idle, Record and the inputs; starting and
  finishing, what is happening; recording, the ring (pause, Space on the
  recording screen), the timer, the microphone and computer audio with
  their levels and level advice (a click mutes), Change inputs (`InputsMenu`:
  the device switches at once with `attempt_device_reconnect`; on failure
  the old one keeps recording), Shrink to floating bar (the minibar,
  `enter_compact_mode`) and Stop.
- **The screen** (`pages/RecordingPage`): the title (click to rename), when it
  started, the folder picker, More actions (copy the transcript, recording
  settings), then Notes, Transcript (live, with speaker naming) and Summary
  ("Summarize so far": `ask_live_assistant` with the newest lines within
  12 000 characters and, to steer it, the first 3 000 characters of the
  notes, the old UI's budgets, since native sends the context to the model
  in one request; not saved).
- **Busy and the updater**: the save and a recovery report `recordingSave` and a running
  or queued pass `postCall` (Native data above; `usePostCallBusy` reads it
  from the jobs); a failed pass waiting for the user holds nothing.
- `store/queries.ts`: the store works outside React, on the query client
  `RecordingRuntime` registers (the app's, a test's or a story's).
  `store/reset.ts` forgets every module's state; `src/test/setup.ts` runs it
  after each test, with an empty `fake-indexeddb`.
- Mock: `src/mocks/live.ts` (from `162e8be`'s `dev/preview/live.ts`). A start
  emits `recording-started`; outside tests a line of the script every 2.6 s;
  tests speak with `speakMockLine(mockState)`. Stop hands over with a
  `stop_id`, so the real save runs into the sample library.
  `mockState.live` sets the runtime error, a start error, the transcription
  status after Stop, quitting, checkpoints, and records the answers.

## The minibar

`features/recording/minibar` is the whole UI of the `minibar` window, at
`/minibar` (#116). Native code opens the window (`minibar.rs`) during a
recording and hides the main window: minimizing the main window does it
(lib.rs), and so does Shrink to floating bar in the recording bar
(`enter_compact_mode`).

- **Its own JavaScript.** The window shares only localStorage (the theme
  follows by `storage` event) and native state with the main window, and
  mounts neither `RecordingRuntime` nor the session. It polls
  `recordingStateQuery` (`get_recording_state`) every 500 ms, which divides
  the timer's second, so each second shows for a second; the timer is
  native's `active_duration`, never a local counter. `recording-paused`,
  `-resumed` and the two `*-mute-changed` events read it again at once.
  Pause, resume and the mutes call the recording feature's wrappers
  (`api/recording.ts`).
- **Stop** calls `stop_recording_from_minibar`. Native hides the bar and
  brings the main window back as the stop begins, and the main window saves
  the meeting on `recording-stop-complete`, as after any Stop (Recording ›
  Stop and save). Until native closes it, the bar stops polling, holds its
  timer and says Finishing… with a spinner where Stop was. Back to the full
  window is `exit_compact_mode`.
- **The pill** (`MinibarPill`): closed, the ring (pause), the timer over
  Recording, Paused or Finishing…, and Stop. Hover, or keyboard focus inside
  it, opens the rest to its right: the microphone and computer audio
  (`SourceMeter`, computer audio with its level advice), Pause, Back to the
  full window, and Stop's label. A click focuses a button but does not hold
  the pill open once the pointer leaves. Opening moves nothing under the
  pointer: the pill grows from its left edge, and Stop follows the timer.
  The design draws Stop last; there a pointer on its way to Stop would land
  on a mute button as the pill opened. What opens fades in from 4 px to the
  left over `base`; the pill's width changes once.
- **The window.** `minibar.rs` sizes it to the open pill with room for a
  longer status, 512×52 clipped to a 26 px radius, and centres the closed
  pill (170 px) at the top of the primary monitor; `sizes.minibar` in the
  theme repeats the sizes. The pill is the window's height, so it has no
  shadow and the window no tooltips: every button carries its name, the
  ring and Stop their `aria-keyshortcuts`. A press on the pill outside its
  buttons moves the window (`startDragging`, allowed by the `minibar-drag`
  capability).
- **Keys** while the bar has focus: Space pauses and resumes unless a
  button has focus, ⌘R (Ctrl R) stops.
- **Failures** take the status's place for 5 s ("Could not pause", "Could
  not stop"): the window has no room for a toast. After a failed Stop the
  bar and the recording go on.
- **Limits.** While the pill is closed, the transparent rest of the window
  (about 340×52 px to its right) still takes clicks meant for the windows
  under it; giving the window the pill's size would take native resizing
  and, on Windows, a new window region. Not checked on a Mac, where a
  window without focus may not report hover. A Wayland compositor places
  windows itself, so the position there is its choice.
- Tests: `MinibarPage.test.tsx` on the mock (`src/mocks/minibar.ts`: the
  three minibar commands and the window drag; its Stop runs the mock
  recorder's). Stories: `Recording/Minibar`, the pill in each state, and
  `Recording/MinibarPage` on the mock recorder.

## Meetings and the transcript

- `src/api/meetings.ts` is the meetings domain: the list, a meeting's
  header, its whole transcript (one call: a limit of -1 is SQLite's "no
  limit", and playback or a jump can land anywhere), folders (native's
  groups; the Groups page became folders on the list), the summary and its
  run, and the speaker labels. #112 saves a recording through `saveTranscript`,
  files it with `setMeetingFolderMutation` and starts the automatic summary
  with `startSummary`; the meeting screen (#113) uses the rest. A mutation
  invalidates what it changed: a rename the list, the header and the
  folders' counts; a folder renamed or deleted every meeting's folder
  (`meetingKeys.folders()`) and not their transcripts or summaries; a delete
  drops the meeting's own queries instead, so a screen still on it does not
  refetch "Meeting not found".
- `startSummary` reads the whole transcript, writes it as
  `[mm:ss] Speaker: text` lines, picks the language (the one chosen for the
  meeting, else the one detected before, else it detects and keeps it, in
  the old `…Fallback:<meetingId>` keys for a meeting without
  metadata.json) and calls `api_process_transcript`. It names a template
  only when the caller picks one for the run (#119); otherwise native uses
  the stored default (`src/api/templates.ts`: the templates, one read whole,
  custom ones saved and deleted, and the default, which native keeps in
  `summary/template_settings.rs`). Checks of the
  model itself (downloaded, installed) are the caller's. The run goes on
  natively, which holds it as busy work for the updater: `summary-progress`
  says it moved on, and `summaryQuery` also reads it again every 5 s while
  it runs, since a run that fails before its first step sends no event.
- `TranscriptList` (`components/transcript/`) shows a transcript, saved
  or live: one row per turn, consecutive lines of one voice less than
  2.5 s apart joined. Rows off screen are neither laid out nor painted
  (`content-visibility: auto`), so a meeting of several hours costs about
  what its visible rows cost, and rows re-render only when what they show
  changes: the callers' `onSeek` and `onRenameSpeaker` are called through a
  ref, and `clean` runs once per turn when the lines change. The turn being
  played comes from a `PlaybackClock` the player
  passes in; the list writes `data-active` and `aria-current` straight
  onto that row, never through React state, and keeps it in view unless
  the user scrolled in the last 4 s. A `live` list (#112) follows its end
  until the user scrolls up, then offers Latest; its new rows rise in under a veil, and
  keep their element when `live` turns off after Stop. A
  voice other than the user's can be named in place (`onRenameSpeaker`);
  the user's own label comes from the microphone and is never renamed here.

## Settings

- `features/settings` owns `/settings` and `/settings/:page`. The page shows
  the simple settings, or with the Advanced switch on (stored under
  `protocol-settings-advanced`) the four sections in tabs: General,
  Recording, AI and Advanced; the two views swap through `Crossfade`. Both
  use the same rows (`components/PreferenceRows.tsx`), so turning Advanced
  off only hides sections and every value stays.
- `?section=` names the tab, written with `replace`. `sections.ts` maps the
  old UI's nine ids onto the four; one in a link turns Advanced on. `about`
  (the tray's Check for Updates…) lands on General › Updates: `UpdatesGroup`
  reads it, scrolls itself into view and turns the id into `general`.
  Turning Advanced off drops the id.
- The recording preferences are changed through
  `hooks/useRecordingPreferences`, which saves with
  `updateRecordingPreferencesMutation()` and shows a toast if native refuses.
  A volume slider saves 250 ms after it rests, and on unmount if it has not.
- Nothing in Settings opens a device by itself (owner decision 2026-11-25).
  The microphone's Test starts the device preview (`useAudioLevelMonitoring`,
  the chosen microphone by name, or native's default devices) and the meter
  beside Mic volume. The test ends on a second press, when another
  microphone is chosen, when the section or Settings closes, and when a
  recording starts; it never comes back on its own. During a recording the
  meter shows the recording's own microphone level, which opens nothing. The
  meeting language is disabled from Record until the meeting is saved
  (`useRecordingBusy`).
- General › Updates shows the updater snapshot that `updater-status` keeps
  current (App mounts `useUpdaterStatusSync` from `src/api/updater.ts`;
  stories and tests mount it themselves): its status line, the one action
  of the state, the download's progress, the release's notes behind
  "What's new" (`ReleaseNotes` renders the changelog's Markdown subset,
  never HTML), and a busy refusal kept for 10 s. Model updates checks the
  model list (`src/api/modelCatalog.ts`, kept current from
  `model-catalog-changed`); each model's own update is offered on the
  models' pages (#117). Links open with `openLink` (`src/api/links.ts`),
  which logs a failure.
- #117 adds the AI and Advanced panels in `SectionView`
  (`pages/SettingsPage.tsx`), the search beside the tabs, and the pages in
  `pages/SettingsSubpage.tsx` (`PAGES`, `paths.settingsPage`) and in
  `stories/settingsRoutes.ts`, the routes Settings' stories and tests share.
  A page opened from the simple page goes back to it; with Advanced on, it
  goes back to its section.

## The meetings list and the meeting screen

`features/meetings` holds Home (`home/`), the meeting screen (`meeting/`),
what both use (`components/`: the processing views, the rename and folder
sheets) and their helpers (`lib/`). The routes are `/` (`HomeScreen`) and
`/meetings/:meetingId` (`MeetingRoute`, which keys the screen by id, so
another meeting starts from fresh state).

- **Home.** Search filters the list by title and folder name as the user
  types; Escape clears it. Search in transcripts and summaries is #118's.
  The folder chips filter by folder, kept in the URL (`?folder=`) so Back
  from a meeting returns to it; a folder that no longer exists shows
  everything. The selected folder's menu renames or deletes it; its
  meetings stay, in no folder. Rows are grouped by date (`lib/dates.ts`);
  a row's second line is the post-call pass while one runs
  (`ProcessingLine`), else its folder. F2 on a row renames the meeting. A
  meeting added while Home is open (a recording just saved) rises in under a veil;
  filtering does not animate. Home docks the recording bar
  (`Screen recordBar`) and draws no recording controls of its own.
- **Home banners.** "Update ready" shows while `updaterStatusQuery` has an
  offer that is downloaded and installable from the app
  (`lib/updates.ts › readyOffer`). Restart and update calls
  `installUpdate()`; a refusal while work runs says what it waits for
  (`busySentence`), and a failed install shows the snapshot's error.
  Release notes open in a sheet. The permission banner reads the devices
  (no input listed means no microphone) and, on macOS, the Audio Capture
  record or this session's probe (`home/audioAccess.ts`); Check again asks
  the system again and reads both anew. Linux asks for nothing and shows
  none.
- **Update toasts.** `UpdateToasts`, mounted once in the shell, toasts a
  release when it becomes available, a download finished in this session
  (one restored at launch is the banner's alone) and an update that just
  installed, once per version (`protocol-updater-seen-v1`, the old keys),
  and not while a recording runs. Details opens Settings › Updates.
- **Action items.** A finished summary's action section moves into rows
  (`lib/actionItemSync.ts`): the meeting screen calls
  `syncFinishedSummary` when it sees a completed summary, not edited by
  the user, that still has one, whether the run ended there or while the
  user was elsewhere. It reads the summary from native again, so a second
  call finds no section and changes nothing; calls for one meeting share
  one promise. Home runs the backfill of older summaries once per session;
  one whose list call failed runs again on the next visit. The rows sit
  between Decisions and Open questions: the summary splits before its Open
  questions section into two editors (`variant="summary"`, every heading
  a section label like Action items) saved as one summary.
- **The meeting screen.** The header (title; when, how long, folder) and
  its menu: Rename (also F2), Move to folder, Copy transcript, Copy summary,
  Open recording folder, Identify speakers again with a count, Delete.
  Export, Enhance transcript and the summary's options join it with #119.
  Under it the post-call pass's status, then Notes, Transcript and Summary
  (⌘1, ⌘2, ⌘3; `?tab=`, Summary by default), and the player as the
  screen's bar.
- **The player** (`meeting/player.ts`) is one `<audio>` outside React. The
  position is not state: its `PlaybackClock` hands it to the transcript's
  highlight and the player's time and scrubber on every frame while
  playing, so playback renders nothing. Space plays and pauses unless a
  control has focus; ← and → skip 5 s only while the scrubber has focus;
  the speed steps 1×, 1.25×, 1.5×, 2×. A meeting without audio says so in
  the bar.
- **Notes and the edited summary** autosave 600 ms after typing stops and
  at once when the tab or the screen closes (`lib/autosave.ts`). The
  editor reads its content once, so it mounts only once the last save of
  that text has landed (`useSaving` over the mutation's scope): the notes
  are read back after each save, and a saved summary edit is written into
  the cached summary. A new run's summary remounts the editor (keyed by
  the run's end).
- **Writing the summary** (`meeting/summaryRun.ts`): a provider must be
  chosen, and a built-in model downloaded and whole, or a toast leads to
  Settings; then `startSummary`. Writing it again over the user's edits
  asks first. While it runs the tab says so with Cancel; a failure shows
  native's words with Try again. Each `summary-progress` of the meeting
  reads the summary again. Notes do not feed the summary natively, so the
  footnote says "Written from the transcript."
- **Speakers.** "N speakers ▾" on the Transcript tab and the menu's
  Identify speakers again rerun diarization with a count or detecting it
  (`diarizeMeeting`), offered only with a speaker engine, audio and no pass
  running. Native holds the busy reason; the mutation's own callbacks
  refresh the transcript even if the user left the meeting. Naming a voice
  waits until the pass is over, since the pass replaces the labels.
- Tests: `home/*.test.tsx`, `meeting/*.test.tsx` and `lib/*.test.ts` on the
  mock IPC; the notes test holds a save in flight and checks the editor
  waits for it, and the summary's edits are written into its cache.
  Stories: `Meetings/HomeScreen`, `Meetings/PermissionBanner` and
  `Meetings/MeetingScreen`; the screens' stories share `storyRoutes.ts`, so
  a row opens its meeting.
- Not carried over: the player's waveform, Labs' clean transcript, the
  Ollama model check before a run (native's error shows), and the speaker
  dialog's engine-specific wording (`diarization_get_status` is #117's;
  Nemotron ignores the count natively).

## People and search

- `src/api/people.ts` is the people domain (`person.rs`, `voice_profiles.rs`):
  contacts, a contact's profile (meetings together, speaking time), their
  private notes, merge and delete, and the Labs voices; the Labs switch for
  voices is a native lab in `src/api/labs.ts` (`voiceProfiles`). The action
  items a contact owns are `actionItemsQuery({personId})`, which a check-off
  refreshes; the profile's own copy is left out. A rename, merge or delete
  relabels transcript lines and moves or unlinks action items natively, so
  those mutations invalidate the meetings' and the items' queries with the
  people; a merge or delete drops the gone contact's profile. Naming a voice
  (`renameSpeakerMutation`) and learning one can make or link a contact, so
  they read the people again; deleting or moving a meeting does not tell
  people, so the contacts and a profile are read again on every mount
  (`staleTime: 0`). Notes save as the user types (one scope per contact, in
  order) and write the stored text into the cached profile rather than
  reading it again over the field.
- Native links a voice to a contact through `person_speakers` when a voice is
  named: a name equal to a contact's, case and outer spaces aside, joins
  them, any other name becomes a new contact, and generated labels ("You",
  "Speaker N", overlaps) never do (`isPersonLabel`). No command lists a
  meeting's links, so `personForSpeaker` maps a label by the same name rule.
- A voice's label in `TranscriptList` opens a menu of `speakerActions`, the
  caller's (`SpeakerTarget` in: the label and the turn's lines, the first
  being the turn's id; `SpeakerAction` out: id, label, icon, onSelect),
  ending with Rename speaker where the voice can be renamed. A voice with no action but the rename
  starts it from the label at once. The function is called as rows render,
  so it must be stable. #118 adds "Open <contact>", #119 "Who said this…".
- Mock: `src/mocks/people.ts` derives who spoke where from the transcripts,
  as `person_speakers` follows the labels. It wraps two of the meetings
  mock's handlers with what native does in the same write:
  `rename_meeting_speaker` makes a contact of a new name, and
  `api_list_action_items` answers with owners linked to their contacts.

## Mock IPC

Outside Tauri, `pnpm dev`, Storybook and every test run on
`@tauri-apps/api/mocks`: `src/mocks/ipc.ts` routes commands to
`src/mocks/handlers.ts` and delivers events to the page's listeners.

- A handler is keyed by the Rust command name, or `plugin:<plugin>|<command>`
  for what `@tauri-apps/api` sends. It reads and changes `mockState`
  (`src/mocks/state.ts`), so a mutation shows up on the next query; throwing
  rejects like an `Err`.
- `mockState` holds only what some handler reads; `createMockState()` builds
  it and `resetMockState()` restores it (tests and stories call it before each
  case).
- The task that adds a domain's handlers ports that domain's handlers and
  sample data from the old browser preview, `162e8be:frontend/src/dev/preview/`
  (`index.ts`: the handlers; `fixtures.ts`: meetings, groups, people,
  transcripts, summaries; `live.ts`: recording; `models.ts`: speech models;
  `intel.ts`: Intel GPUs), into a domain file of its own,
  `src/mocks/<domain>.ts`, as `src/mocks/notes.ts` does: `<domain>Handlers(state)`
  returns the handlers, spread into `handlers`, and `createMock<Domain>()`
  builds the sample data, called from `createMockState`. The handlers take
  the state as an argument because `state.ts` imports the domain file, so
  importing `mockState` back would make a cycle. A domain with no sample
  data of its own, as `src/mocks/audio.ts`, keeps its few fields inline in
  `createMockState` and exports its handlers as an object that reads
  `mockState`, since `state.ts` does not import it. Parallel tasks then add one
  line each to `handlers.ts` and `state.ts` instead of editing the same
  blocks. It types the data with the domain's payload types from `src/api`
  or `features/<x>/api`, never with interfaces of its own, so a field that
  changes in the payload type stops the stale sample data from compiling.
- A command native code registers on one platform only (`#[cfg]` in
  `generate_handler!`; "Windows only" or "macOS only" in PARITY.md) goes into
  `platformHandlers.windows` or `platformHandlers.macos`, never `handlers`.
  The mock answers it only when `mockState.platform` matches; elsewhere it
  rejects with Tauri's `Command <name> not found`, so the preview and the
  tests reach the screen's "not available" path as the app does on that
  platform. `resetMockState()` sets it from `src/lib/platform.ts` (`?platform=`
  in the browser); a test or story of the available path sets it before
  rendering (see Tests). A command in both maps stops the mock from loading.
- A command without a handler rejects with a message naming
  `src/mocks/handlers.ts`, so a screen never renders an empty reply as data.
- To push an event, call `emitMockEvent(EVENT, payload)`; in `pnpm dev`, the
  console has `__PROTOCOL_MOCK__.emit(...)` and `__PROTOCOL_MOCK__.state`.
- `?firstLaunch` in `pnpm dev` starts as a new install: no database, no
  first launch saved and no models (`src/mocks/onboarding.ts`,
  `src/mocks/models.ts`).

## Storybook

Every component in `components/ui` and every feature component gets a story
file next to it with at least a `Light` and a `Dark` story:

```ts
export const Light: Story = {globals: {theme: 'light'}}
export const Dark: Story = {globals: {theme: 'dark'}}
```

The decorator in `.storybook/preview.tsx` provides the theme, `GlobalStyle`,
`UiProviders` and a query client on the mock IPC. The toolbar switches the
theme for stories that do not set it.

A screen's story renders in `StoryWindow` (`components/screen/`): a frame
of the main window's 460×700 with a memory router made once from the
feature's routes, as Settings (`SettingsStoryWindow`) and the meetings
screens do.

`@storybook/addon-a11y` runs axe on every story in its Accessibility panel, in
both themes; a violation there is fixed in the component, not hidden in the
story.

## Tests

- Vitest with Testing Library on jsdom; files are `*.test.ts(x)` next to the
  code. Import `describe`, `it`, `expect` and `vi` from `vitest`.
- `src/test/setup.ts` installs the mock IPC on a fresh state before each test
  and clears the DOM, the theme mode, the toasts and localStorage after it.
  It also gives jsdom the pointer capture methods Radix's toasts call. A
  fake model download (`src/mocks/models.ts`) steps
  `mockState.models.downloadStep` percent every 250 ms and fails halfway for
  a key in `mockState.models.failing`. Change a reply
  for one test with `vi.spyOn(handlers, 'command').mockImplementation(…)`; spies
  are restored after each test.
- Tests run as `linux`: jsdom's user agent names no other platform. To test
  a Windows- or macOS-only command's available path, set
  `mockState.platform = 'windows'` (or `'macos'`) before rendering;
  `resetMockState()` restores it before the next test. It changes only what
  the mock answers, not `platform` from `src/lib/platform.ts`.
- The mock's `open_external_url` opens nothing (jsdom has no `window.open`):
  it appends the link to `mockState.openedUrls`, for the test to check.
- The mock takes the window label from the path when it is installed
  (`minibar` for `/minibar`, otherwise `main`). A test of the minibar sets the
  path, then calls `installMockIpc()` again before rendering.
- jsdom has no `matchMedia`; `setSystemDark()` from `src/test/matchMedia.ts`
  flips the OS theme.
- Test behavior through the UI: roles and visible text, `userEvent` for input.
  `renderUi` (`src/test/renderUi.ts`) renders under the light theme and
  `UiProviders`, as the app does; its `rerender` keeps them.
  Give each test its own client from `createTestQueryClient()`
  (`src/test/queryClient.ts`): it does not retry, so a rejected command shows
  as an error at once instead of after Query's 7 s of retries.
- `listen()` registers asynchronously; wait one macrotask
  (`setTimeout(resolve, 0)`) after mounting before emitting an event, and one
  after emitting before reading what `useEventQuerySync` wrote: it awaits the
  cancel first.
